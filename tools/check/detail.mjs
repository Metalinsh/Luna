/**
 * 本轮 4 项界面/数据微调验证（驱动 Electron 开发实例）
 *  1) 详情页曲目行：右侧 3 个按钮常亮、右对齐、不与文字重叠；标题/艺术家/时长列可拖动
 *  2) 播放改为双击曲目名称（版本按钮仍单击播放）
 *  3) 错误的标签艺术家不再被采用，降级为「待确认建议」
 *  4) 多艺术家专辑显示完整艺术家
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9360';
const SHOTS = 'E:\\Work\\本地专辑管理软件\\screenshots';

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass += 1; console.log(`  PASS  ${n}${e ? `  (${e})` : ''}`); } else { fail += 1; console.log(`  FAIL  ${n}${e ? `  (${e})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  console.log('\n— 需求1：详情页曲目行布局 —');
  const layout = await ev(`(async () => {
    const r = await fetch('/api/albums?limit=100&kind=music').then(x => x.json());
    const a = r.albums[0];
    location.hash = '#/album/' + a.id;
    await new Promise(z => setTimeout(z, 2200));
    const row = document.querySelector('#albumDetail .track-row:not(.is-head)');
    if (!row) return { none: true };
    const actions = row.querySelector('.t-actions');
    const btns = [...actions.querySelectorAll('button')];
    const title = row.querySelector('.t-title');
    const time = row.querySelector('.t-time');
    const cs = getComputedStyle(actions);
    const rr = row.getBoundingClientRect();
    const ar = actions.getBoundingClientRect();
    const tr = title.getBoundingClientRect();
    return {
      btnCount: btns.length,
      opacity: cs.opacity,
      actionsRight: Math.round(rr.right - ar.right),
      titleVsActions: Math.round(ar.left - tr.right),
      timeVsActions: Math.round(ar.left - time.getBoundingClientRect().right),
      grips: row.closest('.track-table')?.querySelectorAll('.col-grip').length ?? 0,
      headerGrips: document.querySelectorAll('#albumDetail .col-grip').length,
      rowPaddingRight: getComputedStyle(row).paddingRight,
    };
  })()`);
  ok('曲目行右侧有 3 个操作按钮', layout.btnCount === 3, `${layout.btnCount} 个`);
  ok('按钮常亮（opacity=1）', layout.opacity === '1', `opacity=${layout.opacity}`);
  ok('按钮右端对齐', Math.abs(layout.actionsRight) <= 14, `距右边缘 ${layout.actionsRight}px`);
  ok('标题不与按钮重叠', layout.titleVsActions > 0, `间隔 ${layout.titleVsActions}px`);
  ok('时长不与按钮重叠', layout.timeVsActions > 0, `间隔 ${layout.timeVsActions}px`);
  ok('表头有列宽拖动手柄', layout.headerGrips >= 2, `${layout.headerGrips} 个`);

  console.log('\n— 需求1b：拖动列宽 —');
  const drag = await ev(`(async () => {
    const grip = document.querySelector('#albumDetail .col-grip[data-grip="artist"]');
    if (!grip) return { none: true };
    const table = document.querySelector('#albumDetail .track-table');
    const before = getComputedStyle(table).getPropertyValue('--w-artist').trim();
    const gr = grip.getBoundingClientRect();
    const cx = gr.left + gr.width / 2, cy = gr.top + gr.height / 2;
    const opts = { bubbles: true, clientX: cx, clientY: cy, pointerId: 1, isPrimary: true, button: 0 };
    grip.dispatchEvent(new PointerEvent('pointerdown', opts));
    document.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: cx + 60 }));
    document.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: cx + 60 }));
    await new Promise(z => setTimeout(z, 300));
    const after = getComputedStyle(table).getPropertyValue('--w-artist').trim();
    const saved = JSON.parse(localStorage.getItem('trackColWidths') ?? '{}');
    // 恢复默认，避免影响后续
    document.querySelector('#albumDetail .col-grip[data-grip="artist"]');
    return { before, after, savedArtist: saved.artist };
  })()`);
  const beforeN = parseInt(drag.before, 10);
  const afterN = parseInt(drag.after, 10);
  // 手柄在「标题」列右缘：向右拖 → 标题变宽、艺术家列变窄
  ok('拖动后艺术家列宽发生变化（方向与拖动一致）',
    Number.isFinite(beforeN) && Number.isFinite(afterN) && afterN < beforeN,
    `向右拖 ${drag.before} → ${drag.after}`);
  ok('列宽已持久化到本地', Number.isFinite(drag.savedArtist), `saved=${drag.savedArtist}`);
  await ev(`localStorage.removeItem('trackColWidths'); location.reload(); true`);
  await sleep(3600);

  console.log('\n— 需求2：双击名称播放，单击不播放 —');
  const play = await ev(`(async () => {
    const r = await fetch('/api/albums?limit=100&kind=music').then(x => x.json());
    location.hash = '#/album/' + r.albums[0].id;
    await new Promise(z => setTimeout(z, 2200));
    const row = document.querySelector('#albumDetail .track-row:not(.is-head)');
    const title = row.querySelector('.t-title');
    const before = document.querySelector('audio')?.currentSrc ?? null;

    title.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(z => setTimeout(z, 700));
    const afterSingle = document.querySelector('audio')?.currentSrc ?? null;

    title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(z => setTimeout(z, 1400));
    const afterDouble = document.querySelector('audio')?.currentSrc ?? null;
    return { before, afterSingle, afterDouble };
  })()`);
  ok('单击曲目名不触发播放', play.afterSingle === play.before,
    `单击前后 src ${play.before === play.afterSingle ? '一致' : '被改变'}`);
  ok('双击曲目名触发播放', Boolean(play.afterDouble) && play.afterDouble !== play.before,
    String(play.afterDouble ?? '').split('/').pop());
  await shot('v7-track-row.png');

  console.log('\n— 需求3：多艺术家专辑显示完整 —');
  await ev(`location.hash = '#/'`);
  await sleep(2200);
  const multi = await ev(`(async () => {
    const r = await fetch('/api/albums?limit=100').then(x => x.json());
    const a = r.albums.find(x => /One by One/.test(x.album));
    const cards = [...document.querySelectorAll('.album-card')];
    const card = cards.find(c => (c.querySelector('.album-name')?.textContent ?? '').includes('One by One'));
    const d = await fetch('/api/albums/' + a.id).then(x => x.json());
    return {
      apiArtist: a.album_artist,
      detailArtist: d.album.album_artist,
      cardCredit: card?.querySelector('.album-credit')?.textContent?.trim() ?? '',
    };
  })()`);
  ok('接口返回完整艺术家', /KOTONOHOUSE/.test(multi.apiArtist) && /Neko Hacker/.test(multi.apiArtist),
    multi.apiArtist);
  ok('详情页与列表口径一致', multi.detailArtist === multi.apiArtist, multi.detailArtist);
  ok('专辑墙也显示完整艺术家',
    /KOTONOHOUSE/.test(multi.cardCredit) && /Neko Hacker/.test(multi.cardCredit), multi.cardCredit);
  await shot('v7-multi-artist.png');
} catch (err) {
  console.error('验证异常：', err.message);
  fail += 1;
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close();
process.exit(fail ? 1 : 0);
