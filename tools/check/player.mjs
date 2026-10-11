/**
 * 第 7 轮验证：底部播放组件常态显示 + 详情页复用同一条播放条
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9360';
const SHOTS = path.join(process.cwd(), 'screenshots');

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass += 1; console.log(`  PASS  ${n}${e ? `  (${e})` : ''}`); } else { fail += 1; console.log(`  FAIL  ${n}${e ? `  (${e})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /^https?:\/\//.test(t.url ?? ''));
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
await sleep(4000);
await ev(`location.hash = '#/'`);
await sleep(1800);

try {
  console.log('\n— 需求1：启动时播放组件常态完整显示 —');
  const startup = await ev(`(() => {
    const p = document.querySelector('#player');
    const cs = getComputedStyle(p);
    const r = p.getBoundingClientRect();
    const app = document.querySelector('.app').getBoundingClientRect();
    return {
      hidden: p.hidden, display: cs.display, height: Math.round(r.height),
      bottom: Math.round(window.innerHeight - r.bottom),
      z: cs.zIndex,
      cover: Boolean(document.querySelector('#npCover')),
      playBtn: Boolean(document.querySelector('#playBtn')),
      seek: Boolean(document.querySelector('#seek')),
      modeBtn: Boolean(document.querySelector('#modeBtn')),
      curTime: document.querySelector('#curTime')?.textContent,
      durTime: document.querySelector('#durTime')?.textContent,
      appBottom: Math.round(app.bottom),
      // 主内容区底部与播放条顶部之间不应有空隙
      gap: Math.round(r.top - app.bottom),
      viewportH: window.innerHeight,
    };
  })()`);
  ok('播放组件未被隐藏', startup.hidden === false && startup.display !== 'none', `display=${startup.display}`);
  ok('组件完整（封面/播放键/进度条/模式键齐全）',
    startup.cover && startup.playBtn && startup.seek && startup.modeBtn,
    `封面=${startup.cover} 播放键=${startup.playBtn} 进度条=${startup.seek} 模式=${startup.modeBtn}`);
  ok('贴合窗口底部（无黑条空隙）',
    startup.bottom === 0 && startup.gap <= 1,
    `距底 ${startup.bottom}px · 与内容区间隙 ${startup.gap}px`);
  ok('高度正常（约 88px）', startup.height >= 70 && startup.height <= 110, `${startup.height}px`);
  await shot('v11-startup-player.png');

  console.log('\n— 需求2：详情页复用同一组件（非复制体） —');
  const detail = await ev(`(async () => {
    const a = (await fetch('/api/albums?limit=100&kind=voice').then(x => x.json())).albums
      .find(x => x.rj_code === 'RJ01113481');
    location.hash = '#/album/' + a.id;
    await new Promise(z => setTimeout(z, 2000));
    document.querySelector('#playAlbumBtn').click();
    await new Promise(z => setTimeout(z, 3000));
    // 记录主界面播放条的 DOM 节点身份
    const playerBefore = document.querySelector('#player');
    const rectBefore = playerBefore.getBoundingClientRect();
    document.querySelector('#npOpen').click();
    await new Promise(z => setTimeout(z, 1600));
    const playerAfter = document.querySelector('#player');
    const rectAfter = playerAfter.getBoundingClientRect();
    return {
      sameNode: playerBefore === playerAfter,
      npVisible: !document.querySelector('#nowPlaying').hidden,
      beforeTop: Math.round(rectBefore.top), afterTop: Math.round(rectAfter.top),
      afterBottom: Math.round(window.innerHeight - rectAfter.bottom),
      afterHeight: Math.round(rectAfter.height),
      playerZ: getComputedStyle(playerAfter).zIndex,
      npZ: getComputedStyle(document.querySelector('#nowPlaying')).zIndex,
      // 播放条是否被浮层遮住：取两元素中心点做命中测试
      hitTop: (() => { const el = document.elementFromPoint(window.innerWidth/2, rectAfter.top + 10);
        return el ? (el.closest('#player') ? 'player' : el.className || el.tagName) : 'none'; })(),
      playerInsideNp: Boolean(document.querySelector('#nowPlaying #player')),
      titleSize: parseFloat(getComputedStyle(document.querySelector('#npBigTitle')).fontSize),
      coverPct: Math.round(document.querySelector('#npLeft').getBoundingClientRect().width
        / document.querySelector('#npGrid').getBoundingClientRect().width * 100),
    };
  })()`);
  ok('详情页里的播放条就是主界面那一个（同一 DOM 节点）',
    detail.sameNode === true && detail.playerInsideNp === false, `同一节点=${detail.sameNode}`);
  ok('浮层打开后播放条仍完全可见', detail.hitTop === 'player',
    `命中元素=${detail.hitTop}`);
  ok('位置与高度未被改变',
    detail.beforeTop === detail.afterTop && detail.afterBottom === 0 && detail.afterHeight >= 70,
    `top ${detail.beforeTop}→${detail.afterTop} · 高 ${detail.afterHeight}px · 距底 ${detail.afterBottom}px`);
  ok('播放条层级高于浮层', Number(detail.playerZ) > Number(detail.npZ),
    `player=${detail.playerZ} > np=${detail.npZ}`);
  ok('详情页仍有大字标题与半窗宽封面',
    detail.titleSize >= 26 && Math.abs(detail.coverPct - 50) <= 3,
    `${detail.titleSize}px · 封面 ${detail.coverPct}%`);
  await shot('v11-detail-with-main-player.png');

  console.log('\n— 需求3：详情页已移除 4 个播放模式按钮 —');
  const modes = await ev(`(() => ({
    npModes: Boolean(document.querySelector('#npModes')),
    npModeBtns: document.querySelectorAll('#nowPlaying [data-mode]').length,
    mainModeBtn: Boolean(document.querySelector('#modeBtn')),
    mainModeTitle: document.querySelector('#modeBtn')?.title ?? '',
    npPlayer: Boolean(document.querySelector('#npPlayer')),
    npSeek: Boolean(document.querySelector('#npSeek')),
  }))()`);
  ok('详情页不再有播放模式按钮组', modes.npModes === false && modes.npModeBtns === 0,
    `npModes=${modes.npModes} 按钮=${modes.npModeBtns}`);
  ok('主界面的模式按钮仍可用', modes.mainModeBtn === true, modes.mainModeTitle);
  ok('详情页不再有重复的播放条', modes.npPlayer === false && modes.npSeek === false);

  console.log('\n— 需求2b：详情页里的播放条仍可操作 —');
  const ctrl = await ev(`(async () => {
    const audio = document.querySelector('audio');
    const before = audio.paused;
    document.querySelector('#playBtn').click();
    await new Promise(z => setTimeout(z, 900));
    const after = audio.paused;
    document.querySelector('#playBtn').click();
    await new Promise(z => setTimeout(z, 500));
    const t = document.querySelector('#curTime').textContent;
    // 快进 5 秒
    const t0 = audio.currentTime;
    document.querySelector('#fwd5Btn').click();
    await new Promise(z => setTimeout(z, 400));
    return { before, after, curTime: t, delta: Math.round(audio.currentTime - t0) };
  })()`);
  ok('详情页中播放/暂停按钮生效', ctrl.before !== ctrl.after, `${ctrl.before} → ${ctrl.after}`);
  ok('详情页中快进按钮生效', ctrl.delta >= 4 && ctrl.delta <= 6, `+${ctrl.delta}s`);
  ok('时间随播放更新', /^\d+:\d\d$/.test(ctrl.curTime), ctrl.curTime);

  await ev(`document.querySelector('#npClose')?.click(); true`);

  console.log('\n— 需求4：顺序播放 —');
  const seq = await ev(`(async () => {
    // 播放模式按钮在主界面底部播放条上（详情浮层里已按要求移除）
    const btn = document.querySelector('#modeBtn');
    const seen = [];
    let title = btn.title;
    for (let i = 0; i < 5 && !/顺序播放/.test(title); i += 1) {
      seen.push(title.replace(/.*：/, '').replace(/（.*/, ''));
      btn.click();
      await new Promise(z => setTimeout(z, 250));
      title = btn.title;
    }
    return { seen, title, cycled: /顺序播放/.test(title) };
  })()`);
  ok('播放模式循环中包含「顺序播放」', seq.cycled === true, `${seq.seen.join(' → ')} → 顺序播放`);
  ok('切换到顺序播放后按钮标题更新', /播放模式：顺序播放/.test(seq.title), seq.title);

  const stopAtEnd = await ev(`(async () => {
    // 用只有 1 首曲目的专辑：播完后应停止而不是回卷。
    // 不能假定「第一张音乐专辑就是单曲」——库里可能有整张原声压缩包（几十首）。
    const r = await fetch('/api/albums?limit=200&kind=music').then(x => x.json());
    let picked = null;
    let pickedDetail = null;
    for (const a of r.albums) {
      const d = await fetch('/api/albums/' + a.id).then(x => x.json());
      if ((d.tracks ?? []).length === 1) { picked = a; pickedDetail = d; break; }
    }
    if (!picked) {
      // 兜底：选曲目最少的那张，并如实报告（断言会指出前提不成立）
      const sorted = [...r.albums].sort((a, b) => (a.track_count ?? 0) - (b.track_count ?? 0));
      picked = sorted[0];
      pickedDetail = await fetch('/api/albums/' + picked.id).then(x => x.json());
    }
    location.hash = '#/album/' + picked.id;
    await new Promise(z => setTimeout(z, 2000));
    document.querySelector('#playAlbumBtn').click();
    await new Promise(z => setTimeout(z, 1500));
    const audio = document.querySelector('audio');
    audio.dispatchEvent(new Event('ended'));
    await new Promise(z => setTimeout(z, 900));
    return {
      queueLen: (pickedDetail.tracks ?? []).length,
      album: picked.album,
      pausedAfter: audio.paused,
      bodyToasts: [...document.querySelectorAll('.toast, .toast-item, #toastBox *')]
        .map(e => e.textContent.trim()).join(' | ').slice(0, 80),
    };
  })()`);
  ok('样本专辑只有 1 首（最后一首）', stopAtEnd.queueLen === 1,
    `${stopAtEnd.queueLen} 首（${String(stopAtEnd.album).slice(0, 26)}）`);
  ok('播完后停止（不回卷到第一首）',
    stopAtEnd.pausedAfter === true || /顺序播放结束/.test(stopAtEnd.bodyToasts),
    `paused=${stopAtEnd.pausedAfter} toast="${stopAtEnd.bodyToasts}"`);
  await shot('v8-sequential-mode.png');

  console.log('\n— 音量：0–200%（100% 以上为软件放大） —');
  const vol = await ev(`(async () => {
    const input = document.querySelector('#volume');
    const label = document.querySelector('#volumeVal');
    const a = document.querySelector('audio');
    const set = (v) => { input.value = String(v); input.dispatchEvent(new Event('input', { bubbles: true })); };
    const before = { max: input.max, min: input.min, tick: !!document.querySelector('.volume-mark') };
    set(150);
    await new Promise(z => setTimeout(z, 300));
    const at150 = {
      label: label.textContent,
      boost: document.querySelector('#volumeBox').classList.contains('is-boost'),
    };
    set(50);
    await new Promise(z => setTimeout(z, 300));
    // 接上 Web Audio 后音量由 gain 决定、元素音量恒为 1；未接图时这里会是 0.5
    const at50 = { label: label.textContent, elementVolume: a.volume };
    set(85);
    await new Promise(z => setTimeout(z, 200));
    return { before, at150, at50 };
  })()`);
  ok('音量条量程扩到 0–200 且带 100% 刻度',
    vol.before.max === '200' && vol.before.min === '0' && vol.before.tick === true,
    `min=${vol.before.min} max=${vol.before.max} tick=${vol.before.tick}`);
  ok('超过 100% 时给出「放大」提示', vol.at150.label === '150%' && vol.at150.boost === true,
    `${vol.at150.label} boost=${vol.at150.boost}`);
  ok('放大由 Web Audio 承担（元素音量恒为 1，避免两处叠加）',
    vol.at50.elementVolume === 1, `at50 elementVolume=${vol.at50.elementVolume}`);
} catch (err) {
  console.error('验证异常：', err.message);
  fail += 1;
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close();
process.exit(fail ? 1 : 0);
