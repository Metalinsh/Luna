/**
 * 专辑详情「图片预览」与「图片不再被当成音频版本」的界面检查。
 *
 * 断言分三层：
 *   1) 解析层回归 —— 专辑的曲目里不得出现图片扩展名（历史缺陷：压缩包内图片成了特典版本）
 *   2) 接口层 —— 图片清单按文件夹分组、原图可按 key 取到、越权/不存在的 key 一律 404
 *   3) 界面层 —— 详情页渲染出图片预览栏目；点缩略图弹出原图浮层，ESC 可关闭
 *
 * 依赖开发实例（CDP 9360 / API 8799）。库里若没有「带图片的专辑」则整体跳过。
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9360';
const API = 'http://127.0.0.1:8799';
const SHOTS = 'E:\\Work\\本地专辑管理软件\\screenshots';

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass += 1; console.log(`  PASS  ${n}${e ? `  (${e})` : ''}`); } else { fail += 1; console.log(`  FAIL  ${n}${e ? `  (${e})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, o) => (await fetch(API + p, o)).json();

const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp)$/i;

const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /^https?:\/\//.test(t.url ?? ''));
if (!page) { console.error('未找到应用页面'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, x) => { ws.onopen = r; ws.onerror = x; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
  }
};
const send = (method, params = {}) => {
  id += 1;
  return new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });
};
const ev = async (expr, ms = 30000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('求值超时')), ms)),
  ]);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败');
  return r.result.value;
};
const shot = async (f) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, f), Buffer.from(r.data, 'base64'));
};

await send('Page.enable'); await send('Runtime.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(3600);

try {
  console.log('\n— 找出一个「带图片」的专辑作为样本 —');
  const albums = (await j('/api/albums?limit=200')).albums;
  let sample = null; let gallery = null;
  for (const a of albums) {
    const g = await j(`/api/albums/${a.id}/images`).catch(() => null);
    if (g?.images?.length) { sample = a; gallery = g; break; }
  }
  if (!sample) {
    console.log('  库里没有带图片的专辑，跳过本区域检查');
    console.log('\n结果：0 通过 / 0 失败（已跳过）');
    ws.close();
    process.exit(0);
  }
  console.log(`  样本：${sample.album}（#${sample.id}，来源 ${gallery.source}，${gallery.images.length} 张）`);

  console.log('\n— 需求1：图片不再被当成音频版本 —');
  const detail = await j(`/api/albums/${sample.id}`);
  const tracks = detail.tracks ?? [];
  ok('曲目列表里没有图片扩展名',
    !tracks.some((t) => IMAGE_RE.test(t.filename ?? t.path ?? t.ext ?? '')),
    `${tracks.length} 条曲目`);
  if (sample.kind === 'voice') {
    const bad = (detail.versions ?? []).filter((v) => IMAGE_RE.test(String(v.name ?? '')));
    ok('版本列表里没有图片形成的版本', bad.length === 0, (detail.versions ?? []).map((v) => v.name).join(' | '));
  }

  console.log('\n— 需求2：图片清单按文件夹分组 —');
  ok('返回图片清单', gallery.images.length > 0, `${gallery.images.length} 张`);
  ok('清单里全是图片', gallery.images.every((i) => IMAGE_RE.test(i.name)), gallery.images.map((i) => i.name).join(','));
  const covered = new Set(gallery.groups.flatMap((g) => g.indices));
  ok('分组覆盖全部图片', covered.size === gallery.images.length,
    gallery.groups.map((g) => `${g.label}×${g.indices.length}`).join(' | '));
  ok('分组名取自所在文件夹', gallery.groups.every((g) => typeof g.label === 'string' && g.label.length > 0),
    gallery.groups.map((g) => g.label).join(' | '));

  console.log('\n— 需求3：点缩略图看原图（接口层） —');
  const first = gallery.images[0];
  const res = await fetch(API + first.url);
  const buf = Buffer.from(await res.arrayBuffer());
  ok('原图可取到', res.ok && buf.length > 0, `HTTP ${res.status} · ${(buf.length / 1024).toFixed(0)} KB`);
  ok('响应类型是图片', String(res.headers.get('content-type') ?? '').startsWith('image/'),
    String(res.headers.get('content-type')));

  const bad1 = await fetch(`${API}/api/albums/${sample.id}/image?p=..%2F..%2F..%2FWindows%2Fwin.ini`);
  ok('越权路径被拒绝', bad1.status === 404, `HTTP ${bad1.status}`);
  const bad2 = await fetch(`${API}/api/albums/${sample.id}/image?p=__not_exists__.jpg`);
  ok('不存在的图片被拒绝', bad2.status === 404, `HTTP ${bad2.status}`);

  console.log('\n— 需求4：界面上的图片预览栏目与看原图浮层 —');
  const ui = await ev(`(async () => {
    location.hash = '#/';
    await new Promise(z => setTimeout(z, 900));
    location.hash = '#/album/${sample.id}';
    await new Promise(z => setTimeout(z, 2600));
    const box = document.querySelector('#albumDetail .image-gallery');
    const groups = [...document.querySelectorAll('#albumDetail .gallery-group')];
    const thumbs = [...document.querySelectorAll('#albumDetail .gallery-thumb')];
    return {
      hasBox: Boolean(box),
      open: box?.open === true,
      summary: box?.querySelector('summary')?.textContent?.replace(/\\s+/g,' ').trim() ?? '',
      groups: groups.map(g => g.querySelector('.gallery-group-head')?.textContent?.replace(/\\s+/g,' ').trim() ?? ''),
      thumbs: thumbs.length,
      afterTracks: Boolean(box) && (() => {
        const table = document.querySelector('#albumDetail .track-table');
        return table ? (table.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 : false;
      })(),
    };
  })()`);
  ok('详情页渲染出图片预览栏目', ui.hasBox === true, ui.summary);
  ok('栏目默认展开', ui.open === true);
  ok('栏目位于曲目列表下方', ui.afterTracks === true);
  ok('分组标题渲染正确', ui.groups.length === gallery.groups.length, ui.groups.join(' | '));
  ok('缩略图数量与清单一致', ui.thumbs === gallery.images.length, `${ui.thumbs}/${gallery.images.length}`);
  await shot('v11-gallery.png');

  // 缩略图是浏览器侧生成的小图，等它换成 blob: 之后再点开原图
  await ev(`(async () => {
    for (let i = 0; i < 40; i += 1) {
      const img = document.querySelector('#albumDetail .gallery-thumb img');
      if (img && (img.currentSrc || img.src || '').startsWith('blob:')) return true;
      await new Promise(z => setTimeout(z, 250));
    }
    return false;
  })()`);

  const lb = await ev(`(async () => {
    document.querySelector('#albumDetail .gallery-thumb').click();
    await new Promise(z => setTimeout(z, 900));
    const box = document.querySelector('#lightbox');
    const img = document.querySelector('#lightboxImg');
    return {
      visible: box?.hidden === false,
      src: img?.getAttribute('src') ?? '',
      caption: document.querySelector('#lightboxCaption')?.textContent ?? '',
      hasNav: Boolean(document.querySelector('#lightboxPrev')) && Boolean(document.querySelector('#lightboxNext')),
    };
  })()`);
  ok('点缩略图弹出原图浮层', lb.visible === true);
  ok('浮层加载的是原图地址', /\/api\/albums\/\d+\/image\?p=/.test(lb.src), lb.src.slice(0, 70));
  ok('浮层显示序号与文件名', /\d+\s*\/\s*\d+/.test(lb.caption), lb.caption.slice(0, 60));
  ok('提供上一张/下一张', lb.hasNav === true);
  await shot('v11-lightbox.png');

  const closed = await ev(`(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(z => setTimeout(z, 500));
    return document.querySelector('#lightbox')?.hidden === true;
  })()`);
  ok('ESC 关闭浮层', closed === true);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
} catch (err) {
  console.error('验证异常：', err.message);
  fail += 1;
}
ws.close();
process.exit(fail ? 1 : 0);
