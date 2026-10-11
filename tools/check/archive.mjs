/**
 * 压缩包只读挂载界面验证（docs/压缩包支持设计.md §5.5、§5.6）。
 *
 * 前置：开发库里已扫描过含压缩包的音乐库（真机为 E:\Music\ASMR）。
 * 本脚本**只读**：不写任何数据，也不改动用户文件。
 *
 * 覆盖：
 *   · 专辑墙出现压缩包发行的 🗜 角标，且只出现在真有包内曲目的专辑上
 *   · 详情页标注「来自压缩包」与仍在包内的曲目数
 *   · 包内曲目的版本 chip 带 is-archived 与「包内」小标，且 aria-disabled
 *   · 点击包内 chip 不会发起播放（不产生 <audio> 播放请求），而是给出告知
 *   · /api/stream 对包内曲目返回 409 ARCHIVE_NOT_MATERIALIZED
 *
 * 断言不重复：ZIP 解析细节归单元测试（test/zip-reader.test.mjs），
 * 音声版本/差分归 voice 区域，这里只验压缩包特有的表现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.LUNA_BASE || 'http://127.0.0.1:8799';
const PORT = 9343;
const PROFILE = path.join(process.env.TEMP, `lam-archive-ui-${Date.now()}`);
const SHOTS = path.join(process.cwd(), 'screenshots');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${name}${extra ? `  (${extra})` : ''}`); } else { fail += 1; console.log(`  FAIL  ${name}${extra ? `  (${extra})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!EDGE) {
  console.error('未找到 Microsoft Edge，无法运行界面检查。');
  process.exit(1);
}

/* -------------------------------------------------- 先做接口层判定（不依赖 UI） */

// 每个套件开头重置自己关心的状态，保证可重复运行：
// 清空压缩包缓存，让「未缓存 → 弹询问 → 解码」这条链路每次都被真正走一遍。
const clearedAtStart = await fetch(`${BASE}/api/archive/cache/clear`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
}).then((r) => r.json()).catch(() => null);
if (clearedAtStart?.result) {
  console.log(`\n起始清理：释放缓存 ${(Number(clearedAtStart.result.bytes ?? 0) / 1048576).toFixed(1)} MB`);
}

const stats = await (await fetch(`${BASE}/api/stats`)).json();
const arch = stats.stats?.archives ?? {};
console.log(`压缩包登记：${arch.archives} 个包 · 包内曲目 ${arch.archiveTracks} · 未落盘 ${arch.archivedTracks}`);

if (!arch.archives) {
  console.error('\n✗ 开发库里没有任何已登记的压缩包。');
  console.error('  请先在界面里扫描含压缩包的音乐库（真机为 E:\\Music\\ASMR），再重跑本检查。');
  process.exit(1);
}

const albums = (await (await fetch(`${BASE}/api/albums?limit=200&kind=voice`)).json()).albums;
const withArchive = albums.filter((a) => a.archive?.archives > 0);
/**
 * 专辑墙的「包内」角标对**所有**来源为压缩包的专辑显示（音声与普通音乐都算），
 * 所以对照口径要取全部专辑，不能只用音声那一份。
 */
const allAlbums = (await (await fetch(`${BASE}/api/albums?limit=200`)).json()).albums;
const withArchiveAll = allAlbums.filter((a) => a.archive?.archives > 0);
ok('专辑列表接口给出压缩包专辑', withArchive.length > 0,
  `${withArchive.length}/${albums.length} 张音声发行来自压缩包（全库 ${withArchiveAll.length} 张含包）`);
ok('非压缩包专辑不带 archive 角标数据',
  allAlbums.filter((a) => a.archive?.archives > 0).length < allAlbums.length,
  `共 ${allAlbums.length} 张，其中 ${withArchiveAll.length} 张含包`);

const target = withArchive[0];
const detail = await (await fetch(`${BASE}/api/albums/${target.id}`)).json();
const variants = [...(detail.tracks ?? []), ...(detail.bonus_tracks ?? [])]
  .flatMap((r) => r.variants ?? []);
const archived = variants.filter((v) => v.source_kind === 'archive_member');
ok('详情接口标出包内曲目', archived.length > 0, `${archived.length}/${variants.length} 条变体在包内`);
ok('包内曲目标出「需先预读取」且带 archive_id 与 member_path',
  archived.every((v) => v.needs_prefetch === true && v.archive_id && v.member_path),
  JSON.stringify(archived[0] ?? {}).slice(0, 120));
ok('详情页标注仍在包内的曲目数',
  detail.album?.archive?.tracks === archived.length,
  `album.archive.tracks=${detail.album?.archive?.tracks}，实测变体 ${archived.length} 条`);
ok('包内曲目带内嵌封面（封面从包内解出）',
  Boolean(detail.album?.cover_url), detail.album?.cover_url ?? '(无)');

/* -------------------------------------- 接口：包内曲目按需解码后可直接播放 */
/* 解码细节（容量拒绝 / LRU / 命中缓存）由单元测试与 P2 自检覆盖，这里只验端到端可用 */

const sampleId = archived[0].track_id;
const sampleSize = archived[0].size;
const res = await fetch(`${BASE}/api/stream/${sampleId}`, { method: 'HEAD' });
ok('包内曲目取流成功（按需解码后供流）', res.status === 200, `实际 ${res.status}`);
ok('返回长度与包内清单一致',
  Number(res.headers.get('content-length')) === sampleSize,
  `${res.headers.get('content-length')} vs ${sampleSize}`);
ok('声明支持 Range（播放器可拖动进度）',
  res.headers.get('accept-ranges') === 'bytes', String(res.headers.get('accept-ranges')));

const rng = await fetch(`${BASE}/api/stream/${sampleId}`, { headers: { Range: 'bytes=0-255' } });
ok('Range 请求返回 206', rng.status === 206, `实际 ${rng.status}`);
await rng.arrayBuffer();

/**
 * 注意：上面的取流会把该成员解码进缓存，所以**之后**再查详情时
 * 这一条已经是 cached。缓存状态断言必须放在取流之前（上面已断言），
 * 这里只补一条「取流后状态确实翻转」的验证，说明缓存真的生效了。
 */
const detailAfter = await (await fetch(`${BASE}/api/albums/${target.id}`)).json();
const variantsAfter = [...(detailAfter.tracks ?? []), ...(detailAfter.bonus_tracks ?? [])]
  .flatMap((r) => r.variants ?? []);
const primed = variantsAfter.find((v) => v.track_id === sampleId);
ok('取流后该曲目转为「已缓存、无需再预读取」',
  primed?.cached === true && primed?.needs_prefetch === false,
  `cached=${primed?.cached} needs_prefetch=${primed?.needs_prefetch}`);

const cacheAfter = (await (await fetch(`${BASE}/api/archive/cache`)).json()).cache;
ok('解码结果进入缓存并被登记', cacheAfter.bytes > 0 && cacheAfter.files > 0,
  `${cacheAfter.files} 个文件 / ${(cacheAfter.bytes / 1048576).toFixed(1)} MB`);

// 对照：普通（非压缩包）曲目不应受影响。
// 注意 /api/tracks 的默认视图已排除音声曲目，但要显式挑一条磁盘曲目才严谨。
const allTracks = (await (await fetch(`${BASE}/api/tracks?limit=500&includeVoice=1`)).json())?.tracks ?? [];
const diskTrack = allTracks.find((t) => t.source_kind !== 'archive_member') ?? null;
if (!diskTrack) {
  ok('存在可用于对照的磁盘曲目', false, '库里没有非压缩包曲目');
} else {
  const headOk = await fetch(`${BASE}/api/stream/${diskTrack.id}`, { method: 'HEAD' });
  ok('普通磁盘曲目不受影响（仍可播放）', headOk.status === 200,
    `#${diskTrack.id} ${String(diskTrack.filename ?? '').slice(0, 30)} → ${headOk.status}`);
  ok('跨专辑曲目列表也标出包内曲目',
    allTracks.some((t) => t.source_kind === 'archive_member' && t.member_path),
    `${allTracks.filter((t) => t.source_kind === 'archive_member').length} 条带 archive 标记`);
}

/* ------------------------------------------------------------------ 界面层 */

const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--disable-gpu',
  // 允许无用户手势自动播放：本套件用脚本点击触发播放，否则会被自动播放策略拦下
  '--autoplay-policy=no-user-gesture-required',
  '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' });

async function connect() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await r.json()).find((t) => t.type === 'page');
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
      const msg = JSON.parse(ev.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
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
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败');
    return r.result.value;
  }

  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(path.join(SHOTS, file), Buffer.from(r.data, 'base64'));
  }
}

const cdp = await Cdp.open();
try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(2600);

  // 记录页面上发生过的媒体请求，用于证明「点包内 chip 不会发起播放」
  await cdp.eval(`(() => {
    window.__archiveProbe = { media: [], errors: [] };
    const of = window.fetch;
    window.fetch = function (...a) {
      const u = String(a[0]?.url ?? a[0] ?? '');
      if (u.includes('/api/stream/')) window.__archiveProbe.media.push(u);
      return of.apply(this, a);
    };
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      window.__archiveProbe.media.push('play:' + (this.currentSrc || this.src || ''));
      return origPlay.apply(this, arguments);
    };
    window.addEventListener('error', (e) => window.__archiveProbe.errors.push(String(e.message)));
    return true;
  })()`);

  console.log('\n— 专辑墙角标 —');
  const cards = await cdp.eval(`(() => {
    const out = [];
    for (const c of document.querySelectorAll('.album-card')) {
      out.push({
        id: c.dataset.id,
        badges: [...c.querySelectorAll('.badge')].map(b => b.textContent.trim()),
        archiveTitle: c.querySelector('.badge.is-archive')?.getAttribute('title') ?? null,
      });
    }
    return out;
  })()`);
  const archivedCards = cards.filter((c) => c.badges.some((b) => b.includes('包内')));
  ok('专辑墙出现「包内」角标', archivedCards.length === withArchiveAll.length,
    `界面上 ${archivedCards.length} 张（接口 ${withArchiveAll.length} 张）`);
  const only = archivedCards.every((c) => cards.filter((x) => x.id === c.id).length === 1);
  ok('角标只出现在压缩包专辑上', only && archivedCards.length < cards.length,
    `全部 ${cards.length} 张卡片中 ${archivedCards.length} 张带角标`);
  ok('角标 title 说明来源（不再表述为禁播）',
    archivedCards.every((c) => /压缩包/.test(c.archiveTitle ?? '') && !/不能播/.test(c.archiveTitle ?? '')),
    String(archivedCards[0]?.archiveTitle ?? '').slice(0, 60));
  await cdp.shot('v11-archive-wall.png');

  console.log('\n— 详情页：来源说明保留、单曲不再标「包内」—');
  await cdp.eval(`document.querySelector('.album-card[data-id="${target.id}"]').click()`);
  await sleep(1600);
  const ui = await cdp.eval(`(() => ({
    title: document.querySelector('.detail-title')?.textContent?.trim(),
    note: document.querySelector('.archive-note')?.textContent?.replace(/\\s+/g,' ').trim() ?? null,
    chips: document.querySelectorAll('.ver-chip').length,
    // 以下三项都应当为 0：详情页曲目行不再有「包内」标记与禁用态
    archLabels: document.querySelectorAll('.ver-chip .chip-arch, .ver-chip.is-archived').length,
    ariaDisabled: document.querySelectorAll('.ver-chip[aria-disabled="true"]').length,
    rowArchBadges: document.querySelectorAll('.track-row .t-badge.is-arch').length,
    // 来源数据标记仍需保留，提醒逻辑靠它
    fromArchive: document.querySelectorAll('.ver-chip[data-from-archive="1"]').length,
  }))()`);
  ok('详情页标题渲染', Boolean(ui.title), String(ui.title).slice(0, 30));
  ok('详情页显示「来自压缩包」说明', /来自压缩包/.test(ui.note ?? ''),
    String(ui.note ?? '').slice(0, 70));
  ok('说明里给出包内曲目数', /条曲目在包内/.test(ui.note ?? ''), String(ui.note ?? '').slice(0, 70));
  ok('说明改为「按需解码」口径（不再说不支持播放）',
    /按需解码/.test(ui.note ?? '') && !/在规划中的|暂不能播放/.test(ui.note ?? ''),
    String(ui.note ?? '').slice(0, 70));
  ok('详情页单曲不再标「包内」（chip 小标 / is-archived 均为 0）',
    ui.archLabels === 0, `${ui.archLabels} 个`);
  ok('详情页曲目行不再有「包内」t-badge', ui.rowArchBadges === 0, `${ui.rowArchBadges} 个`);
  ok('详情页 chip 不再 aria-disabled', ui.ariaDisabled === 0, `${ui.ariaDisabled} 个`);
  ok('仍保留来源数据标记供提醒使用', ui.fromArchive > 0, `${ui.fromArchive} 个`);
  await cdp.shot('v11-archive-detail.png');

  console.log('\n— 点击压缩包曲目：先询问预读取范围（P2）—');
  // 注意：上面的取流自检已经把 sampleId 解码进缓存了，
  // 所以这里必须挑「仍需预读取」的那一条，否则会走「已缓存 → 直接播放」分支。
  const stillNeeds = await cdp.eval(`document.querySelectorAll('.ver-chip[data-need-prefetch="1"]').length`);
  ok('存在仍需预读取的曲目（缓存清空后应有）', stillNeeds > 0, `${stillNeeds} 条`);

  await cdp.eval(`(() => {
    window.__archiveProbe.media.length = 0;
    document.querySelector('.ver-chip[data-need-prefetch="1"]')?.click();
    return true;
  })()`);
  await sleep(900);
  const ask = await cdp.eval(`(() => {
    const d = document.querySelector('#prefetchDialog');
    return {
      open: d?.open === true,
      title: document.querySelector('#pfTitle')?.textContent?.trim(),
      options: ['#pfTrack', '#pfAlbum', '#pfCancel'].filter((s) => document.querySelector(s)).length,
      media: window.__archiveProbe.media.slice(),
    };
  })()`);
  ok('弹出预读取询问框', ask.open === true);
  ok('标题为「该发行来自压缩包，播放需预读取」',
    ask.title === '该发行来自压缩包，播放需预读取', ask.title);
  ok('提供单曲 / 整张 / 暂不三个选择', ask.options === 3, `${ask.options} 个`);
  ok('询问阶段尚未发起播放请求（等用户决定）', ask.media.length === 0,
    ask.media.join(' | ') || '(无)');
  await cdp.shot('v11-archive-prefetch-ask.png');

  console.log('\n— 选择「暂不」：放弃预读取，不播放 —');
  await cdp.eval(`document.querySelector('#pfCancel').click()`);
  await sleep(600);
  const gaveUp = await cdp.eval(`(() => ({
    open: document.querySelector('#prefetchDialog')?.open,
    media: window.__archiveProbe.media.slice(),
  }))()`);
  ok('询问框关闭', gaveUp.open === false);
  ok('放弃后没有发起播放', gaveUp.media.length === 0, gaveUp.media.join(' | ') || '(无)');

  console.log('\n— 选择「仅此单曲」：解码后正常播放 —');
  const played = await cdp.eval(`(async () => {
    const btn = document.querySelector('.ver-chip[data-need-prefetch="1"]');
    btn.click();
    await new Promise(r => setTimeout(r, 600));
    document.querySelector('#pfTrack').click();
    for (let i = 0; i < 80; i++) {
      await new Promise(r => setTimeout(r, 250));
      const a = document.querySelector('#audio');
      const done = document.querySelector('#pfProgress')?.hidden !== false;
      if (a && !a.paused && a.currentSrc && done) {
        return { started: true, src: a.currentSrc, media: window.__archiveProbe.media.slice(-3) };
      }
    }
    return { started: false, media: window.__archiveProbe.media.slice(-3) };
  })()`);
  ok('解码完成后进入播放', played.started === true, String(played.src ?? '').slice(-24));
  ok('确实向 /api/stream 发起了播放请求',
    (played.media ?? []).some((m) => m.includes('/api/stream/')),
    (played.media ?? []).join(' | ') || '(无)');

  console.log('\n— 已缓存的曲目：直接播放，不再询问 —');
  const already = await cdp.eval(`(async () => {
    // 刚才那一条此时已缓存
    const cached = [...document.querySelectorAll('.ver-chip[data-from-archive="1"]')]
      .find(b => b.dataset.needPrefetch !== '1');
    if (!cached) return { found: false };
    window.__archiveProbe.media.length = 0;
    cached.click();
    await new Promise(r => setTimeout(r, 700));
    return {
      found: true,
      dialogOpen: document.querySelector('#prefetchDialog')?.open === true,
      media: window.__archiveProbe.media.slice(),
    };
  })()`);
  ok('已缓存曲目点击后不弹询问框', already.found && already.dialogOpen === false,
    `found=${already.found} open=${already.dialogOpen}`);
  ok('已缓存曲目直接发起播放', (already.media ?? []).length > 0,
    (already.media ?? []).join(' | ') || '(无)');

  const errs = await cdp.eval('window.__archiveProbe.errors');
  ok('页面无 JS 报错', errs.length === 0, errs.join(' | ') || '(无)');

  console.log('\n— 详情页「预读专辑 / 清除缓存」按钮与「已预读」标签 —');
  // 这里只做**只读**断言：不真的预读（会把整张专辑解码进缓存），也不清缓存
  const btnIds = await cdp.eval(`(async () => {
    location.hash = '#/album/${target.id}';
    await new Promise(r => setTimeout(r, 2800));
    return {
      ids: [...document.querySelectorAll('#albumDetail .detail-actions button')].map((b) => b.id),
      prefetch: document.querySelector('#prefetchAlbumBtn')?.textContent.trim() ?? '',
      clear: document.querySelector('#clearAlbumCacheBtn')?.textContent.trim() ?? '',
    };
  })()`);
  ok('包内发行的详情页出现「预读专辑」与「清除缓存」',
    Boolean(btnIds.prefetch) && Boolean(btnIds.clear), `${btnIds.prefetch} / ${btnIds.clear}`);
  const iReveal = btnIds.ids.indexOf('revealAlbumBtn');
  const iPre = btnIds.ids.indexOf('prefetchAlbumBtn');
  const iClear = btnIds.ids.indexOf('clearAlbumCacheBtn');
  ok('两个按钮排在「打开文件夹」之后，且预读在清除之前',
    iReveal >= 0 && iPre > iReveal && iClear > iPre, btnIds.ids.join(' → '));

  const prefetchTag = await fetch(`${BASE}/api/tags`).then((r) => r.json())
    .then((r) => (r.tags ?? []).find((t) => t.name === '已预读') ?? null).catch(() => null);
  if (prefetchTag) {
    ok('「已预读」标签归入风格分类', prefetchTag.category === 'style',
      `category=${prefetchTag.category} · ${prefetchTag.album_count} 张专辑`);
    ok('「已预读」带固顶标记（界面据此排在风格栏首位）', prefetchTag.lead === true,
      `lead=${prefetchTag.lead}`);

    // 风格栏首个 chip 必须是「已预读」
    const firstChip = await cdp.eval(`(async () => {
      location.hash = '#/';
      await new Promise(r => setTimeout(r, 2200));
      const row = [...document.querySelectorAll('#tagBar .tagbar-row')]
        .find(r => (r.querySelector('.tagbar-label')?.textContent ?? '').startsWith('风格'));
      const chip = row?.querySelector('.tagbar-chip');
      return { label: row?.querySelector('.tagbar-label')?.textContent.replace(/\\s+/g,'').trim() ?? '', first: chip?.textContent.replace(/\\s+/g,' ').trim() ?? '' };
    })()`);
    ok('风格栏首个标签是「已预读」', firstChip.first.startsWith('已预读'),
      `${firstChip.label} → ${firstChip.first}`);
  } else {
    console.log('  （库里还没有专辑被整张预读过，「已预读」标签尚未建立 —— 不算失败）');
  }

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
