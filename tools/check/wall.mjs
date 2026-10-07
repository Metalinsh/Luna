/**
 * Luna 界面验证（CDP 驱动 headless Edge）
 * 覆盖：Luna 品牌、角标位置、❤ 喜欢、喜欢的作品、唱歌快进/倒退、全部曲目只含 Album
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// 默认对 Electron 开发实例（8799）；也可用 LUNA_BASE 指向其它地址
const BASE = process.env.LUNA_BASE || 'http://127.0.0.1:8799';
const PORT = 9345;
const PROFILE = path.join(process.env.TEMP, `luna-ui-${Date.now()}`);
const SHOTS = 'E:\\Work\\本地专辑管理软件\\screenshots';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${name}${extra ? `  (${extra})` : ''}`); } else { fail += 1; console.log(`  FAIL  ${name}${extra ? `  (${extra})` : ''}`); }
};

const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--disable-gpu', '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 等待 */ }
    await sleep(300);
  }
  throw new Error('无法连接浏览器调试端口');
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }

  static async open() {
    const ws = new WebSocket(await connect());
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new Cdp(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && cdp.pending.has(m.id)) {
        const { resolve, reject } = cdp.pending.get(m.id);
        cdp.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      }
    };
    return cdp;
  }

  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败');
    return r.result.value;
  }

  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, file), Buffer.from(r.data, 'base64'));
  }
}

const cdp = await Cdp.open();
try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(2800);

  console.log('\n— 品牌更名 —');
  const brand = await cdp.eval(`({ title: document.title, brand: document.querySelector('.brand-title')?.textContent?.trim() })`);
  ok('标题已是 Luna', /Luna/.test(brand.title ?? ''), brand.title);
  ok('侧栏品牌显示 Luna', brand.brand === 'Luna', brand.brand);

  console.log('\n— 角标位置（右下角）—');
  const badge = await cdp.eval(`(() => {
    const card = document.querySelector('.album-card');
    const cover = card?.querySelector('.album-cover');
    const b = card?.querySelector('.badges');
    if (!b) return { none: true };
    const cr = cover.getBoundingClientRect(), br = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    return {
      flexWrap: cs.flexWrap, justify: cs.justifyContent, whiteSpace: getComputedStyle(b.querySelector('.badge')).whiteSpace,
      rightGap: Math.round(cr.right - br.right), bottomGap: Math.round(cr.bottom - br.bottom),
      topGap: Math.round(br.top - cr.top),
      labels: [...b.querySelectorAll('.badge')].map(x => x.textContent.trim()),
    };
  })()`);
  ok('角标容器位于封面右下角',
    badge.rightGap >= 0 && badge.rightGap < 20 && badge.bottomGap >= 0 && badge.bottomGap < 20 && badge.topGap > 20,
    `右 ${badge.rightGap}px / 下 ${badge.bottomGap}px / 上 ${badge.topGap}px`);
  ok('角标允许换行且单个标签不换行',
    badge.flexWrap === 'wrap' && badge.whiteSpace === 'nowrap', `wrap=${badge.flexWrap} nowrap=${badge.whiteSpace}`);
  ok('角标内容为版本数', (badge.labels ?? []).some((l) => /版本/.test(l)), (badge.labels ?? []).join(' | '));
  await cdp.shot('v4-luna-wall.png');

  console.log('\n— 喜欢 —');
  // 先重置状态：窗口会跨多次运行复用，避免上次运行留下的「已喜欢」干扰
  await cdp.eval(`(async () => {
    const r = await fetch('/api/albums?limit=100').then(x => x.json());
    for (const a of r.albums) {
      if (a.favorite) await fetch('/api/albums/' + a.id + '/favorite',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: false }) });
    }
    return true;
  })()`);
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(3000);

  const fav = await cdp.eval(`(async () => {
    const btn = document.querySelector('.fav-btn');
    if (!btn) return { none: true };
    const cover = btn.closest('.album-cover');
    const br = btn.getBoundingClientRect(), cr = cover.getBoundingClientRect();
    const wasOn = btn.classList.contains('is-on');
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    const after = document.querySelector('.fav-btn[data-fav="' + btn.dataset.fav + '"]');
    return {
      top: Math.round(br.top - cr.top), right: Math.round(cr.right - br.right),
      wasOn, nowOn: after.classList.contains('is-on'),
      albumId: Number(btn.dataset.fav),
      badge: document.querySelector('#favoriteBadge')?.textContent?.trim(),
      badgeHidden: document.querySelector('#favoriteBadge')?.hidden,
    };
  })()`);
  ok('❤ 按钮在封面右上角', fav.top >= 0 && fav.top < 20 && fav.right >= 0 && fav.right < 20,
    `上 ${fav.top}px / 右 ${fav.right}px`);
  ok('点击可以点亮', fav.wasOn === false && fav.nowOn === true, `${fav.wasOn} → ${fav.nowOn}`);

  const favSum = await cdp.eval(`fetch('/api/favorites/summary').then(r => r.json())`);
  ok('收藏统计计入该专辑', (favSum.asmr + favSum.albums) >= 1,
    `ASMR ${favSum.asmr} / 专辑 ${favSum.albums} / 音乐 ${favSum.tracks}`);

  const badgeState = await cdp.eval(`(() => {
    const ids = { asmr: '#favAsmrBadge', album: '#favAlbumBadge', track: '#favTrackBadge' };
    const out = {};
    for (const [k, sel] of Object.entries(ids)) {
      const el = document.querySelector(sel);
      out[k] = el ? { hidden: el.hidden, text: el.textContent } : null;
    }
    return out;
  })()`);
  const anyBadgeShown = Object.values(badgeState).some((b) => b && !b.hidden);
  ok('左侧对应收藏入口显示计数', anyBadgeShown,
    Object.entries(badgeState).map(([k, v]) => `${k}=${v ? v.text : '缺失'}`).join(' '));
  await cdp.shot('v4-luna-favorite.png');

  console.log('\n— 收藏入口（已拆分为三处）—');
  const favView = await cdp.eval(`(async () => {
    const navs = [...document.querySelectorAll('.nav-item')].map(b => b.dataset.view);
    const target = ${favSum.asmr > 0 ? "'favasmr'" : "'favalbum'"};
    const nav = [...document.querySelectorAll('.nav-item')].find(b => b.dataset.view === target);
    if (!nav) return { none: true, navs };
    nav.click();
    await new Promise(r => setTimeout(r, 1800));
    const cards = [...document.querySelectorAll('#albumGrid .album-card')];
    return {
      navs,
      lbl: nav.textContent.trim().replace(/\\s+/g, ' '),
      count: cards.length,
      allOn: cards.every(c => c.querySelector('.fav-btn')?.classList.contains('is-on')),
      active: nav.classList.contains('is-active'),
      visible: !document.querySelector('#viewAlbums')?.hidden,
    };
  })()`);
  ok('侧栏存在三个收藏入口',
    ['favasmr', 'favalbum', 'favtracks'].every((v) => (favView.navs ?? []).includes(v)),
    (favView.navs ?? []).join(' / '));
  ok('进入收藏后视图可见（原先会整页空白）', favView.visible === true);
  ok('收藏视图只显示已喜欢的作品', favView.count >= 1 && favView.allOn === true,
    `${favView.count} 张，全部点亮=${favView.allOn}`);
  ok('该入口处于选中态', favView.active === true);
  await cdp.shot('v4-luna-favorites-view.png');

  console.log('\n— 全部曲目只含 Album —');
  const tracks = await cdp.eval(`(async () => {
    const nav = [...document.querySelectorAll('.nav-item')].find(b => b.dataset.view === 'tracks');
    nav.click();
    await new Promise(r => setTimeout(r, 1200));
    const rows = [...document.querySelectorAll('#viewTracks .track-row:not(.is-head)')];
    const r = await fetch('/api/tracks?limit=500').then(x => x.json());
    return {
      domRows: rows.length,
      apiTotal: r.total,
      albums: [...new Set(r.tracks.map(t => t.album_title))],
      anyVoice: r.tracks.some(t => (t.album_title || '').includes('即おち') || (t.album_title || '').includes('青夏')),
    };
  })()`);
  ok('全部曲目不含音声曲目', tracks.anyVoice === false, `总 ${tracks.apiTotal} 首`);
  ok('列表渲染与接口一致', tracks.domRows === tracks.apiTotal, `DOM ${tracks.domRows} / API ${tracks.apiTotal}`);

  console.log('\n— 快进 / 倒退 5 秒 —');
  const seek = await cdp.eval(`(async () => {
    const nav = [...document.querySelectorAll('.nav-item')].find(b => b.dataset.view === 'albums');
    nav.click();
    await new Promise(r => setTimeout(r, 1200));
    const btns = { back: document.querySelector('#back5Btn'), fwd: document.querySelector('#fwd5Btn') };
    if (!btns.back || !btns.fwd) return { none: true, back: !!btns.back, fwd: !!btns.fwd };
    const audio = document.querySelector('audio');
    // 直接给播放器一个可 seek 的时长，避免依赖真实解码
    Object.defineProperty(audio, 'duration', { value: 100, configurable: true });
    audio.currentTime = 50;
    btns.fwd.click();
    const afterFwd = audio.currentTime;
    btns.back.click();
    btns.back.click();
    const afterBack = audio.currentTime;
    audio.currentTime = 99.5;
    btns.fwd.click();
    const clampedTop = audio.currentTime;
    audio.currentTime = 0.5;
    btns.back.click();
    const clampedZero = audio.currentTime;
    return { afterFwd, afterBack, clampedTop, clampedZero, backTitle: btns.back.title, fwdTitle: btns.fwd.title };
  })()`);
  ok('存在快进/倒退按钮', !seek.none, `倒退 title="${seek.backTitle}" / 快进 title="${seek.fwdTitle}"`);
  ok('快进 +5 秒', seek.afterFwd === 55, `50 → ${seek.afterFwd}`);
  ok('倒退 5 秒（连按两次）', seek.afterBack === 45, `55 → ${seek.afterBack}`);
  ok('不会越过结尾', seek.clampedTop === 100, `99.5 → ${seek.clampedTop}`);
  ok('不会退到负数', seek.clampedZero === 0, `0.5 → ${seek.clampedZero}`);

  console.log('\n— 社团字段 —');
  const circle = await cdp.eval(`(async () => {
    const r = await fetch('/api/albums?limit=100').then(x => x.json());
    const v = r.albums.find(a => a.is_voice);
    const d = await fetch('/api/albums/' + v.id).then(x => x.json());
    await fetch('/api/albums/' + v.id + '/circle', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ circle: '测试社团XYZ' }) }).then(x => x.json());
    const hit = await fetch('/api/albums?q=' + encodeURIComponent('测试社团XYZ')).then(x => x.json());
    return { before: d.album.circle, searchHit: hit.total, hasBtn: true };
  })()`);
  ok('社团可通过检索命中', circle.searchHit >= 1, `命中 ${circle.searchHit} 张`);
  ok('社团接口生效', circle.searchHit >= 1);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
} catch (err) {
  console.error('验证脚本异常：', err.message);
  fail += 1;
} finally {
  try { browser.kill(); } catch { /* 忽略 */ }
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
process.exit(fail ? 1 : 0);
