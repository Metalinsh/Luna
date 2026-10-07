/**
 * 本轮 4 项优化验证（驱动 Electron 开发实例）
 *  1) 社团/艺术家自动套用到名称含该文字的其他音声
 *  2) 卡片名称下方显示「[社团] · 艺术家」
 *  3) 收藏拆分为 喜欢的ASMR / 喜欢的专辑 / 喜欢的音乐（含单曲喜欢，音声单曲不收录）
 *  4) 修复「标记喜欢后收藏里空白」
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9360';
const API = 'http://127.0.0.1:8799';
const SHOTS = 'E:\\Work\\本地专辑管理软件\\screenshots';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${name}${extra ? `  (${extra})` : ''}`); } else { fail += 1; console.log(`  FAIL  ${name}${extra ? `  (${extra})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, o) => (await fetch(API + p, o)).json();

const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /^https?:\/\//.test(t.url ?? ''));
if (!page) { console.error('未找到应用页面'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, x) => { ws.onopen = r; ws.onerror = x; });
let id = 0;
const pending = new Map();
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
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
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

await send('Page.enable');
await send('Runtime.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(3500);

try {
  console.log('\n— 准备：清空历史收藏与社团，保证可重复 —');
  await ev(`(async () => {
    const r = await fetch('/api/albums?limit=100').then(x => x.json());
    for (const a of r.albums) {
      if (a.favorite) await fetch('/api/albums/' + a.id + '/favorite',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: false }) });
    }
    const t = await fetch('/api/tracks?limit=500').then(x => x.json());
    for (const x of t.tracks) {
      if (x.favorite) await fetch('/api/tracks/' + x.id + '/favorite',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: false }) });
    }
    return true;
  })()`);

  console.log('\n— 需求1：社团自动套用到名称含该文字的其他音声 —');
  const voice = (await j('/api/albums?limit=100&kind=voice')).albums;
  const source = voice.find((a) => a.rj_code === 'RJ01128508');
  // 另一张：文件夹名里同样含「上海飯店」，但其标题来自内嵌标签、并不含社团名
  const other = voice.find((a) => a.id !== source?.id && a.rj_code === 'RJ01002989');
  ok('存在两张与「上海飯店」相关的音声发行', Boolean(source && other),
    `${source?.rj_code} 与 ${other?.rj_code}（后者标题不含社团名，靠文件夹名匹配）`);
  if (!source || !other) throw new Error('缺少测试所需的音声发行');

  // 先清空两者的社团，再从 source 填一次
  await j(`/api/albums/${source.id}/circle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ circle: '' }),
  });
  await j(`/api/albums/${other.id}/circle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ circle: '' }),
  });
  const propRes = await j(`/api/albums/${source.id}/circle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ circle: '上海飯店' }),
  });
  const otherAfter = await j(`/api/albums/${other.id}`);
  ok('填写后返回被自动套用的作品', (propRes.propagated ?? []).length >= 1,
    (propRes.propagated ?? []).map((p) => p.title.slice(0, 12)).join(' | '));
  ok('另一张含该社团名的音声被自动填上社团', otherAfter.album.circle === '上海飯店',
    String(otherAfter.album.circle));

  // 艺术家同理
  const artRes = await j(`/api/albums/${source.id}/voice-artist`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ artist: '小花衣こっこ' }),
  });
  ok('艺术家接口正常返回', artRes.ok === true);

  console.log('\n— 需求2：卡片显示「[社团] · 艺术家」 —');
  const card = await ev(`(async () => {
    location.hash = '#/';
    await new Promise(z => setTimeout(z, 1600));
    const cards = [...document.querySelectorAll('.album-card')];
    const hit = cards.find(c => (c.querySelector('.album-credit')?.textContent ?? '').includes('上海飯店'));
    return {
      hasCredit: Boolean(hit),
      credit: hit?.querySelector('.album-credit')?.textContent?.trim() ?? '',
      nameAbove: hit ? hit.querySelector('.album-name')?.textContent?.trim().slice(0, 10) : '',
    };
  })()`);
  ok('卡片出现署名行', card.hasCredit === true, card.credit);
  ok('格式为「[社团] · 艺术家」', /^\[上海飯店\] · .+/.test(card.credit), card.credit);
  await shot('v6-credit-line.png');

  console.log('\n— 需求3：收藏拆分为三处 —');
  // 「侧栏有三个收藏入口」「收藏视图不再空白」由 check/wall.mjs 负责，此处不重复验证
  // 标一张音声为喜欢 → 应进「喜欢的ASMR」
  await j(`/api/albums/${source.id}/favorite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: true }),
  });
  // 标一张普通专辑为喜欢 → 应进「喜欢的专辑」
  const music = (await j('/api/albums?limit=100&kind=music')).albums[0];
  await j(`/api/albums/${music.id}/favorite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: true }),
  });

  const sum = await j('/api/favorites/summary');
  ok('收藏统计接口正确', sum.asmr === 1 && sum.albums === 1 && sum.tracks === 0,
    `ASMR ${sum.asmr} / 专辑 ${sum.albums} / 音乐 ${sum.tracks}`);

  const views = await ev(`(async () => {
    const go = async (v) => {
      [...document.querySelectorAll('.nav-item')].find(b => b.dataset.view === v).click();
      await new Promise(z => setTimeout(z, 1700));
      return {
        cards: [...document.querySelectorAll('#albumGrid .album-card')].map(c => c.querySelector('.album-name')?.textContent?.trim().slice(0, 10)),
        rows: document.querySelectorAll('#trackTable .track-row:not(.is-head)').length,
        albumsVisible: !document.querySelector('#viewAlbums')?.hidden,
        tracksVisible: !document.querySelector('#viewTracks')?.hidden,
      };
    };
    return { asmr: await go('favasmr'), album: await go('favalbum') };
  })()`);
  ok('「喜欢的ASMR」只显示 1 张音声', views.asmr.cards.length === 1, views.asmr.cards.join(' | '));
  ok('「喜欢的专辑」只显示 1 张普通专辑', views.album.cards.length === 1, views.album.cards.join(' | '));
  await shot('v6-fav-asmr.png');

  console.log('\n— 需求3b：单曲喜欢 → 喜欢的音乐；音声单曲不收录 —');
  const trackFav = await ev(`(async () => {
    [...document.querySelectorAll('.nav-item')].find(b => b.dataset.view === 'tracks').click();
    await new Promise(z => setTimeout(z, 1700));
    const rows = [...document.querySelectorAll('#trackTable .track-row:not(.is-head)')];
    const withBtn = rows.filter(r => r.querySelector('[data-fav-track]'));
    const btn = withBtn[0]?.querySelector('[data-fav-track]');
    if (!btn) return { none: true, rows: rows.length };
    btn.click();
    await new Promise(z => setTimeout(z, 1300));
    return { none: false, rows: rows.length, withBtn: withBtn.length, isOn: btn.classList.contains('is-on') };
  })()`);
  ok('全部曲目每行都有心形按钮', trackFav.none !== true && trackFav.withBtn === trackFav.rows,
    `${trackFav.withBtn}/${trackFav.rows} 行`);
  ok('点击后点亮', trackFav.isOn === true);

  const favTracks = await ev(`(async () => {
    [...document.querySelectorAll('.nav-item')].find(b => b.dataset.view === 'favtracks').click();
    await new Promise(z => setTimeout(z, 1900));
    return {
      rows: [...document.querySelectorAll('#trackTable .track-row:not(.is-head)')].map(r => r.querySelector('.t-title span')?.textContent?.trim()),
      tracksVisible: !document.querySelector('#viewTracks')?.hidden,
    };
  })()`);
  ok('「喜欢的音乐」收录该单曲', favTracks.rows.length === 1, favTracks.rows.join(' | '));
  ok('「喜欢的音乐」视图可见', favTracks.tracksVisible === true);
  await shot('v6-fav-tracks.png');

  const voiceTrackBlocked = await j('/api/tracks?includeVoice=1&limit=500');
  const vt = voiceTrackBlocked.tracks.find((t) => t.album_kind === 'voice');
  const res = await j(`/api/tracks/${vt.id}/favorite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: true }),
  });
  ok('音声单曲被拒绝收录', res.skipped === true && res.favorite === false, res.note ?? '');
  const sum2 = await j('/api/favorites/summary');
  ok('音声单曲未进入收藏计数', sum2.tracks === 1, `tracks=${sum2.tracks}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
} catch (err) {
  console.error('验证异常：', err.message);
  fail += 1;
}
ws.close();
process.exit(fail ? 1 : 0);
