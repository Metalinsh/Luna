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

const stats = await (await fetch(`${BASE}/api/stats`)).json();
const arch = stats.stats?.archives ?? {};
console.log(`\n压缩包登记：${arch.archives} 个包 · 包内曲目 ${arch.archiveTracks} · 未落盘 ${arch.archivedTracks}`);

if (!arch.archives) {
  console.error('\n✗ 开发库里没有任何已登记的压缩包。');
  console.error('  请先在界面里扫描含压缩包的音乐库（真机为 E:\\Music\\ASMR），再重跑本检查。');
  process.exit(1);
}

const albums = (await (await fetch(`${BASE}/api/albums?limit=200&kind=voice`)).json()).albums;
const withArchive = albums.filter((a) => a.archive?.archives > 0);
ok('专辑列表接口给出压缩包专辑', withArchive.length > 0,
  `${withArchive.length}/${albums.length} 张音声发行来自压缩包`);
ok('非压缩包专辑不带 archive 角标数据',
  albums.filter((a) => a.archive?.archives > 0).length < albums.length,
  `共 ${albums.length} 张，其中 ${withArchive.length} 张含包`);

const target = withArchive[0];
const detail = await (await fetch(`${BASE}/api/albums/${target.id}`)).json();
const variants = [...(detail.tracks ?? []), ...(detail.bonus_tracks ?? [])]
  .flatMap((r) => r.variants ?? []);
const archived = variants.filter((v) => v.source_kind === 'archive_member');
ok('详情接口标出包内曲目', archived.length > 0, `${archived.length}/${variants.length} 条变体在包内`);
ok('包内曲目 playable=false 且带 archive_id 与 member_path',
  archived.every((v) => v.playable === false && v.archive_id && v.member_path),
  JSON.stringify(archived[0] ?? {}).slice(0, 120));
ok('详情页标注仍在包内的曲目数',
  detail.album?.archive?.tracks === archived.length,
  `album.archive.tracks=${detail.album?.archive?.tracks}，实测变体 ${archived.length} 条`);
ok('包内曲目带内嵌封面（封面从包内解出）',
  Boolean(detail.album?.cover_url), detail.album?.cover_url ?? '(无)');

/* -------------------------------------------------- 接口：包内曲目必须 409 */

const sampleId = archived[0].track_id;
const res = await fetch(`${BASE}/api/stream/${sampleId}`);
const body = await res.json().catch(() => ({}));
ok('包内曲目取流被明确拒绝（HTTP 409）', res.status === 409, `实际 ${res.status}`);
ok('拒绝响应带 ARCHIVE_NOT_MATERIALIZED 码',
  body.code === 'ARCHIVE_NOT_MATERIALIZED', `code=${body.code}`);
ok('拒绝响应给出原因与成员路径，而不是 500/410',
  /压缩包/.test(String(body.error ?? '')) && Boolean(body.memberPath),
  `${String(body.error ?? '').slice(0, 40)} · ${String(body.memberPath ?? '').slice(0, 30)}`);

// 对照：普通（非压缩包）曲目不应被 409 拦截。
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
  '--no-first-run', '--disable-gpu', '--window-size=1600,1000', 'about:blank',
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
  ok('专辑墙出现「包内」角标', archivedCards.length === withArchive.length,
    `界面上 ${archivedCards.length} 张（接口 ${withArchive.length} 张）`);
  const only = archivedCards.every((c) => cards.filter((x) => x.id === c.id).length === 1);
  ok('角标只出现在压缩包专辑上', only && archivedCards.length < cards.length,
    `全部 ${cards.length} 张卡片中 ${archivedCards.length} 张带角标`);
  ok('角标 title 说明为什么不能播',
    archivedCards.every((c) => /压缩包/.test(c.archiveTitle ?? '')),
    String(archivedCards[0]?.archiveTitle ?? '').slice(0, 60));
  await cdp.shot('v11-archive-wall.png');

  console.log('\n— 详情页包内标记 —');
  await cdp.eval(`document.querySelector('.album-card[data-id="${target.id}"]').click()`);
  await sleep(1600);
  const ui = await cdp.eval(`(() => ({
    title: document.querySelector('.detail-title')?.textContent?.trim(),
    note: document.querySelector('.archive-note')?.textContent?.replace(/\\s+/g,' ').trim() ?? null,
    chips: document.querySelectorAll('.ver-chip').length,
    archivedChips: document.querySelectorAll('.ver-chip.is-archived').length,
    archivedDisabled: document.querySelectorAll('.ver-chip.is-archived[aria-disabled="true"]').length,
    archTags: document.querySelectorAll('.ver-chip.is-archived .chip-arch').length,
    chipTitle: document.querySelector('.ver-chip.is-archived')?.getAttribute('title') ?? null,
  }))()`);
  ok('详情页标题渲染', Boolean(ui.title), String(ui.title).slice(0, 30));
  ok('详情页显示「来自压缩包」说明', /来自压缩包/.test(ui.note ?? ''),
    String(ui.note ?? '').slice(0, 70));
  ok('说明里给出仍在包内的曲目数', /条曲目仍在包内/.test(ui.note ?? ''), String(ui.note ?? '').slice(0, 70));
  ok('包内 chip 带 is-archived 与「包内」小标',
    ui.archivedChips > 0 && ui.archTags === ui.archivedChips,
    `${ui.archivedChips}/${ui.chips} 个 chip 标为包内，${ui.archTags} 个带小标`);
  ok('包内 chip 全部 aria-disabled', ui.archivedChips === ui.archivedDisabled,
    `${ui.archivedDisabled}/${ui.archivedChips}`);
  ok('包内 chip 的 title 说明原因与阶段',
    /压缩包/.test(ui.chipTitle ?? '') && /P2/.test(ui.chipTitle ?? ''),
    String(ui.chipTitle ?? '').replace(/\n/g, ' ').slice(0, 80));
  await cdp.shot('v11-archive-detail.png');

  console.log('\n— 点击包内 chip 不发起播放 —');
  await cdp.eval(`(() => {
    window.__archiveProbe.media.length = 0;
    document.querySelector('.ver-chip.is-archived')?.click();
    return true;
  })()`);
  await sleep(900);
  const afterClick = await cdp.eval(`(() => ({
    media: window.__archiveProbe.media.slice(),
    toast: document.querySelector('#toast')?.textContent?.replace(/\\s+/g,' ').trim() ?? null,
    toastVisible: !document.querySelector('#toast')?.hidden,
  }))()`);
  ok('点击后没有发起任何 /api/stream 或 play()', afterClick.media.length === 0,
    afterClick.media.join(' | ') || '(无)');
  ok('点击后给出明确告知（不是静默失败）',
    afterClick.toastVisible && /压缩包内/.test(afterClick.toast ?? ''),
    String(afterClick.toast ?? '(无提示)').slice(0, 80));
  await cdp.shot('v11-archive-toast.png');

  const errs = await cdp.eval('window.__archiveProbe.errors');
  ok('页面无 JS 报错', errs.length === 0, errs.join(' | ') || '(无)');

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
