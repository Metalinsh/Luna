/**
 * 音声界面验证（CDP 驱动 headless Edge）
 * 检查：专辑墙角标 → 打开音声专辑 → 版本 chips → 切换播放 → 特典分组 → 问题面板
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.LUNA_BASE || 'http://127.0.0.1:8799';
const PORT = 9341;
const PROFILE = path.join(process.env.TEMP, `lam-voice-ui-${Date.now()}`);
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
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
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
    const url = await connect();
    const ws = new WebSocket(url);
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
    fs.writeFileSync(path.join(SHOTS, file), Buffer.from(r.data, 'base64'));
  }
}

const cdp = await Cdp.open();
try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(2500);

  console.log('\n— 专辑墙 —');
  const cards = await cdp.eval(`(() => {
    const out = [];
    for (const c of document.querySelectorAll('.album-card')) {
      out.push({
        id: c.dataset.id,
        name: c.querySelector('.album-name')?.textContent?.trim(),
        badges: [...c.querySelectorAll('.badge')].map(b => b.textContent.trim()),
      });
    }
    return out;
  })()`);
  const voiceCards = cards.filter((c) => c.badges.some((b) => /版本/.test(b)));
  // 期望张数从接口现算，避免用户新增音声作品后测试失效
  const expVoice = (await (await fetch(BASE + '/api/albums?limit=100&kind=voice')).json()).albums.length;
  ok('专辑墙出现全部音声发行卡片', voiceCards.length === expVoice,
    `找到 ${voiceCards.length} 张（期望 ${expVoice}）：${voiceCards.map((c) => c.badges.join('/')).join(' | ')}`);
  ok('卡片显示版本数角标', voiceCards.every((c) => c.badges.some((b) => /^\d+ 个版本$/.test(b))),
    voiceCards.map((c) => c.badges.find((b) => /版本/.test(b))).join(', '));
  const withBonus = voiceCards.filter((c) => c.badges.includes('含特典'));
  const withVideo = voiceCards.filter((c) => c.badges.includes('含视频版'));
  ok('「含特典」角标只在有特典的发行上', withBonus.length === 1, `${withBonus.length} 张`);
  ok('「含视频版」角标只在有视频的发行上', withVideo.length === 1, `${withVideo.length} 张`);
  await cdp.shot('v3-voice-wall.png');

  console.log('\n— 打开有特典与视频的发行 —');
  const target = voiceCards.find((c) => c.badges.includes('含特典'));
  await cdp.eval(`document.querySelector('.album-card[data-id="${target.id}"]').click()`);
  await sleep(1500);

  const detail = await cdp.eval(`(() => ({
    title: document.querySelector('.detail-title')?.textContent?.trim(),
    kind: document.querySelector('.detail-kind')?.textContent?.trim(),
    rj: document.querySelector('.rj-code')?.textContent?.trim(),
    versionPills: [...document.querySelectorAll('.ver-pill')].map(p => p.textContent.trim().replace(/\\s+/g,' ')),
    rows: document.querySelectorAll('#voiceTrackTable .voice-row:not(.is-head)').length,
    chipsPerRow: [...document.querySelectorAll('#voiceTrackTable .voice-row:not(.is-head)')].slice(0,3).map(r => r.querySelectorAll('.ver-chip').length),
    videoChips: document.querySelectorAll('.ver-chip.is-video').length,
    bonusSummary: document.querySelector('.bonus-box > summary')?.textContent?.trim(),
    notes: document.querySelector('.voice-notes')?.textContent?.trim()?.slice(0, 40),
  }))()`);
  ok('详情页标题正确', Boolean(detail.title), detail.title?.slice(0, 30));
  ok('顶部标注为音声发行并显示 RJ 号', /音声发行/.test(detail.kind ?? '') && /RJ01182623/.test(detail.rj ?? ''), `${detail.kind} / ${detail.rj}`);
  ok('版本列表渲染', detail.versionPills.length === 4, detail.versionPills.join(' | '));
  ok('轨道按轨号合并渲染', detail.rows === 8, `${detail.rows} 行`);
  ok('多数轨道行有多个可切换版本', detail.chipsPerRow.filter((n) => n > 1).length >= 3, `每行 chips：${detail.chipsPerRow.join(',')}`);
  ok('视频版 chip 存在（每轨含中文字幕与日文字幕两版）', detail.videoChips === 16, `${detail.videoChips} 个`);
  ok('特典分组存在且收起', /特典（1 条）/.test(detail.bonusSummary ?? ''), detail.bonusSummary);
  ok('标注「不会写回音频文件」', /不会写回音频文件/.test(detail.notes ?? ''), detail.notes);
  await cdp.shot('v3-voice-detail.png');

  console.log('\n— 版本切换播放 —');
  const switched = await cdp.eval(`(async () => {
    // 选一条「有 ≥2 个音频版本」的轨道行
    const row = [...document.querySelectorAll('#voiceTrackTable .voice-row:not(.is-head)')]
      .find(r => [...r.querySelectorAll('.ver-chip')].filter(c => !c.classList.contains('is-video')).length >= 2);
    if (!row) return { ok: false, reason: '没有可切换的轨道行' };
    const chips = [...row.querySelectorAll('.ver-chip')].filter(c => !c.classList.contains('is-video'));
    const last = chips[chips.length - 1];
    last.click();
    await new Promise(r => setTimeout(r, 1200));
    const a = document.querySelector('audio');
    const src = a?.currentSrc ?? null;
    return {
      ok: true,
      chipCount: chips.length,
      activeLabel: row.querySelector('.ver-chip.is-active')?.textContent?.trim(),
      clickedLabel: last.textContent.trim(),
      clickedTitle: last.title,
      trackId: Number(last.dataset.track),
      src,
    };
  })()`);
  const switchHead = switched.trackId
    ? await fetch(`${BASE}/api/stream/${switched.trackId}`, { method: 'HEAD' })
    : null;
  const switchMime = switchHead?.headers.get('content-type') ?? null;
  ok('点击版本 chip 会切换激活态', switched.ok && switched.activeLabel === switched.clickedLabel,
    switched.ok ? `激活=${switched.activeLabel} 点击=${switched.clickedLabel}` : switched.reason);
  ok('播放器加载了对应的音频源', Boolean(switched.src) && /\/api\/stream\/\d+/.test(switched.src ?? ''),
    `${String(switched.src ?? '').split('/').pop()} · ${switchMime}`);
  ok('切换后的格式与 chip 标注一致',
    Boolean(switched.clickedTitle)
      && switchMime === (switched.clickedTitle.includes('.mp3') ? 'audio/mpeg' : 'audio/wav'),
    `${switched.clickedTitle} → ${switchMime}`);

  console.log('\n— 特典分组展开 —');
  const bonus = await cdp.eval(`(async () => {
    document.querySelector('.bonus-box > summary').click();
    await new Promise(r => setTimeout(r, 400));
    return {
      open: document.querySelector('.bonus-box')?.open,
      rows: document.querySelectorAll('.bonus-box .voice-row:not(.is-head)').length,
    };
  })()`);
  ok('特典展开后显示轨道', bonus.open === true && bonus.rows === 1, `${bonus.rows} 条`);

  console.log('\n— 问题面板（人工确认）—');
  const issues = await cdp.eval(`(async () => {
    document.querySelector('#voiceIssuesBtn').click();
    await new Promise(r => setTimeout(r, 2500));
    const box = document.querySelector('#voiceIssuesBox');
    return {
      text: box?.textContent?.trim()?.slice(0, 60),
      ok: box?.querySelector('.voice-issues.is-ok') !== null,
      conflicts: box?.querySelectorAll('.issue-item').length ?? 0,
    };
  })()`);
  ok('问题检查可运行并给出结论', issues.text?.length > 0, issues.text?.replace(/\s+/g, ' ').slice(0, 50));
  await cdp.shot('v3-voice-issues.png');

  console.log('\n— 视频版弹窗 —');
  const video = await cdp.eval(`(async () => {
    const chip = document.querySelector('.ver-chip.is-video');
    if (!chip) return { ok: false };
    chip.click();
    await new Promise(r => setTimeout(r, 900));
    const modal = document.querySelector('#videoModal');
    const v = modal?.querySelector('video');
    return { ok: Boolean(modal && v), src: v?.getAttribute('src') ?? null, label: chip.textContent.trim() };
  })()`);
  ok('点击视频版打开播放弹窗', video.ok, `${video.label} → ${video.src}`);
  await cdp.shot('v3-voice-video.png');

  console.log('\n— 仅 mp3 版本的发行（RJ01128508）—');
  const mp3Album = await cdp.eval(`(async () => {
    const r = await fetch('/api/albums?limit=50').then(x => x.json());
    const a = r.albums.find(x => x.rj_code === 'RJ01128508');
    if (!a) return { ok: false };
    const d = await fetch('/api/albums/' + a.id).then(x => x.json());
    const withMp3 = d.tracks.filter(t => t.variants.some(v => v.ext === '.mp3'));
    return {
      ok: true,
      id: a.id,
      versions: d.versions.map(v => v.name + ':' + v.preferred_format),
      rows: d.tracks.length,
      mp3Rows: withMp3.length,
      chipCounts: d.tracks.slice(0,4).map(t => t.variants.length),
    };
  })()`);
  ok('RJ01128508 仍是 4 个版本、15 行', mp3Album.versions?.length === 4 && mp3Album.rows === 15,
    `${mp3Album.versions?.join(' | ')}`);
  ok('仅 mp3 的版本以其原生格式呈现', mp3Album.versions?.some((v) => /04_Voice.*mp3/.test(v)),
    mp3Album.versions?.find((v) => /04_Voice/.test(v)));
  ok('该发行每行 4 个版本可切换', mp3Album.chipCounts?.every((n) => n === 4), mp3Album.chipCounts?.join(','));

  console.log('\n— 在界面上切到「仅 mp3 存在」的版本 —');
  const mp3Switch = await cdp.eval(`(async () => {
    location.hash = '#/album/' + ${Number(mp3Album.id)};
    await new Promise(res => setTimeout(res, 2000));
    const row = document.querySelector('#voiceTrackTable .voice-row:not(.is-head)');
    const chip = [...row.querySelectorAll('.ver-chip')].find(c => /04_Voice/.test(c.title));
    if (!chip) return { ok: false, reason: '该行没有 04_Voice chip' };
    chip.click();
    await new Promise(res => setTimeout(res, 1200));
    const src = document.querySelector('audio')?.currentSrc ?? null;
    return {
      ok: true,
      label: chip.textContent.trim(),
      trackId: Number(chip.dataset.track),
      src,
      active: row.querySelector('.ver-chip.is-active')?.textContent?.trim() ?? null,
    };
  })()`);
  const mp3Head = mp3Switch.trackId
    ? await fetch(`${BASE}/api/stream/${mp3Switch.trackId}`, { method: 'HEAD' })
    : null;
  ok('界面上可以切到只有 mp3 的版本', mp3Switch.ok, mp3Switch.label ?? mp3Switch.reason);
  ok('该版本确实以 mp3 播放', mp3Head?.headers.get('content-type') === 'audio/mpeg',
    `${String(mp3Switch.src ?? '').split('/').pop()} · ${mp3Head?.headers.get('content-type')} · 激活=${mp3Switch.active}`);
  await cdp.shot('v3-voice-mp3-version.png');

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
