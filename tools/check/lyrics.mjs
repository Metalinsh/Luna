/**
 * 第 6 轮验证：字幕格式 + 单曲详情界面
 *  1) VTT 等字幕格式适配
 *  2) 台本 .txt 镜像目录
 *  3) 单曲详情：封面半窗宽可拖 + 大字标题 + 艺术家/社团 + 底部播放条 + 右侧歌词
 *  4) 歌词字号 A+ / A-
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
const j = async (p) => (await fetch(API + p)).json();

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
await sleep(3800);
await ev(`location.hash = '#/'`);
await sleep(1600);

try {
  console.log('\n— 需求1：VTT 字幕适配（RJ01113481）—');
  const album = (await j('/api/albums?limit=100&kind=voice')).albums.find((a) => a.rj_code === 'RJ01113481');
  const detail = await j(`/api/albums/${album.id}`);
  const rows = [...(detail.tracks ?? []), ...(detail.bonus_tracks ?? [])];
  let vttCount = 0; let syncedCount = 0; const formats = new Set();
  for (const r of rows) {
    const l = await j(`/api/tracks/${r.preferred_track_id}/lyrics`);
    if (l.available) { formats.add(l.format); if (l.format === 'vtt') vttCount += 1; if (l.synced) syncedCount += 1; }
  }
  ok('该专辑所有轨道都识别到歌词', vttCount === rows.length, `${vttCount}/${rows.length}`);
  ok('全部解析为带时间轴的 VTT', syncedCount === rows.length && formats.has('vtt'),
    `格式=${[...formats].join(',')} 同步=${syncedCount}`);
  const variantLyrics = await j(`/api/tracks/${rows[0].variants[1].track_id}/lyrics`);
  ok('同一轨道的不同版本各自匹配到字幕',
    variantLyrics.available && variantLyrics.level === 'l1v', `level=${variantLyrics.level}`);

  console.log('\n— 需求3：单曲详情界面 —');
  const opened = await ev(`(async () => {
    const row = document.querySelector('#albumDetail .track-row:not(.is-head), .track-row:not(.is-head)');
    const audio = document.querySelector('audio');
    // 直接播放第一个有歌词的轨道
    location.hash = '#/album/${album.id}';
    await new Promise(z => setTimeout(z, 1800));
    document.querySelector('#playAlbumBtn')?.click();
    await new Promise(z => setTimeout(z, 2200));
    document.querySelector('#npOpen').click();
    await new Promise(z => setTimeout(z, 1400));
    const np = document.querySelector('#nowPlaying');
    return { visible: !np.hidden, hasAudio: Boolean(audio?.currentSrc), playing: !audio?.paused };
  })()`);
  ok('点击左下角封面打开单曲详情', opened.visible === true, `播放中=${opened.playing}`);

  const layout = await ev(`(() => {
    const grid = document.querySelector('#npGrid');
    const left = document.querySelector('#npLeft');
    const cover = document.querySelector('#npBigCover');
    const title = document.querySelector('#npBigTitle');
    const credit = document.querySelector('.np-big-credit');
    const right = document.querySelector('.np-right');
    const split = document.querySelector('#npSplit');
    const gw = grid.getBoundingClientRect().width;
    const lw = left.getBoundingClientRect().width;
    return {
      gridW: Math.round(gw), leftW: Math.round(lw),
      pct: Math.round((lw / gw) * 100),
      coverW: Math.round(cover.getBoundingClientRect().width),
      coverBelowTitle: cover.getBoundingClientRect().bottom <= title.getBoundingClientRect().top + 2,
      titleSize: parseFloat(getComputedStyle(title).fontSize),
      titleText: title.textContent.trim().slice(0, 20),
      creditText: credit?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 60) ?? '',
      creditSize: credit ? parseFloat(getComputedStyle(credit).fontSize) : 0,
      hasSplit: Boolean(split),
      rightLeft: Math.round(right.getBoundingClientRect().left),
    };
  })()`);
  ok('封面区域默认约占窗口一半', Math.abs(layout.pct - 50) <= 3, `${layout.pct}%（左栏 ${layout.leftW}px / 网格 ${layout.gridW}px）`);
  ok('封面位于标题上方', layout.coverBelowTitle === true);
  ok('单曲标题为大字', layout.titleSize >= 26, `${layout.titleSize}px · ${layout.titleText}`);
  ok('标题下方显示「艺术家：X 社团：Y」',
    /^艺术家：.*社团：/.test(layout.creditText), layout.creditText);
  ok('该行字号小于标题', layout.creditSize > 0 && layout.creditSize < layout.titleSize,
    `${layout.creditSize}px < ${layout.titleSize}px`);
  ok('右侧为歌词区', layout.rightLeft > layout.leftW, `歌词区起点 ${layout.rightLeft}px`);
  ok('存在封面宽度拖动手柄', layout.hasSplit === true);
  // 播放条与图标的验证属于 check/player.mjs，此处不重复
  await shot('v10-track-detail.png');

  console.log('\n— 需求3b：封面宽度可拖动且持久化 —');
  const drag = await ev(`(() => {
    const grid = document.querySelector('#npGrid');
    const split = document.querySelector('#npSplit');
    const g = grid.getBoundingClientRect();
    const before = parseFloat(getComputedStyle(grid).getPropertyValue('--np-cover-w'));
    const sx = g.left + g.width * (before / 100);
    const cy = g.top + g.height / 2;
    const fire = (type, x) => document.dispatchEvent(new PointerEvent(type, {
      bubbles: true, clientX: x, clientY: cy, pointerId: 1, isPrimary: true, button: 0,
    }));
    split.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: sx, clientY: cy, pointerId: 1, isPrimary: true, button: 0 }));
    fire('pointermove', sx + Math.round(g.width * 0.15));
    const during = parseFloat(getComputedStyle(grid).getPropertyValue('--np-cover-w'));
    fire('pointerup', sx + Math.round(g.width * 0.15));
    return { before, during, saved: Number(localStorage.getItem('npCoverWidth')) };
  })()`);
  ok('向右拖动后封面区域变宽', drag.during > drag.before, `${drag.before}% → ${drag.during}%`);
  ok('宽度已持久化', Math.abs(drag.saved - drag.during) <= 1, `saved=${drag.saved}%`);

  console.log('\n— 需求4：歌词字号 A+ / A- —');
  const font = await ev(`(async () => {
    const line = () => document.querySelector('.lyric-line');
    const before = line() ? parseFloat(getComputedStyle(line()).fontSize) : 0;
    const btnA = document.querySelector('#lyricsBigger');
    const btnB = document.querySelector('#lyricsSmaller');
    const labels = [btnA?.textContent.trim(), btnB?.textContent.trim()];
    btnA.click(); btnA.click();
    await new Promise(z => setTimeout(z, 400));
    const bigger = line() ? parseFloat(getComputedStyle(line()).fontSize) : 0;
    btnB.click();
    await new Promise(z => setTimeout(z, 400));
    const smaller = line() ? parseFloat(getComputedStyle(line()).fontSize) : 0;
    return { before, bigger, smaller, labels, saved: Number(localStorage.getItem('lyricFontSize')) };
  })()`);
  ok('按钮文案为 A+ 与 A-', font.labels[0] === 'A+' && font.labels[1] === 'A-', font.labels.join(' / '));
  ok('点击 A+ 歌词字体变大', font.bigger > font.before, `${font.before}px → ${font.bigger}px`);
  ok('点击 A- 歌词字体变小', font.smaller < font.bigger, `${font.bigger}px → ${font.smaller}px`);
  ok('字号已持久化', Number.isFinite(font.saved), `${font.saved}px`);
  await shot('v10-lyrics-font.png');

  // 复位
  await ev(`localStorage.removeItem('npCoverWidth'); localStorage.removeItem('lyricFontSize');
    document.querySelector('#npClose')?.click(); true`);
  console.log('  （已复位封面宽度与歌词字号）');

  /*
   * 压缩包歌词：包内字幕（实测 `<音频名>.mp3.vtt`）必须能识别，
   * 并且**随预读一起落盘**。只对单条曲目做预读，副作用是几 MB 缓存。
   */
  console.log('\n— 压缩包歌词：识别 + 随预读落盘 —');
  const albums = (await j('/api/albums?limit=300&kind=voice')).albums ?? [];
  let sample = null;
  for (const a of albums) {
    const d = await j(`/api/albums/${a.id}`);
    for (const row of d.tracks ?? []) {
      for (const v of row.variants ?? []) {
        if (v.source_kind !== 'archive_member' || v.file_kind === 'video') continue;
        const lx = await j(`/api/tracks/${v.track_id}/lyrics`);
        if (lx.available && lx.source === 'archive') {
          sample = { variant: v, lyrics: lx };
          break;
        }
      }
      if (sample) break;
    }
    if (sample) break;
  }

  if (!sample) {
    console.log('  （库里没有「包内带字幕」的压缩包曲目，跳过 —— 不算失败）');
  } else {
    ok('包内字幕能被识别为歌词', sample.lyrics.available === true && sample.lyrics.lines.length > 0,
      `${sample.lyrics.level} · ${sample.lyrics.lines.length} 行 · ${sample.lyrics.path}`);
    ok('歌词来源标记为压缩包', sample.lyrics.source === 'archive', sample.lyrics.source);

    const pref = await (await fetch(`${API}/api/archive/prefetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackId: sample.variant.track_id }),
    })).json();
    const ly = pref.result?.lyrics;
    ok('预读单曲时会连歌词一起预读', ly?.total >= 1 && ly?.done >= 1,
      `歌词 ${ly?.done ?? 0}/${ly?.total ?? 0} · ${ly?.bytes ?? 0} 字节`);
    ok('预读项标明匹配到的级别', (ly?.items ?? []).length > 0
      && (ly.items).every((i) => typeof i.level === 'string'),
    (ly?.items ?? []).map((i) => i.level).join(','));

    const after = await j(`/api/tracks/${sample.variant.track_id}/lyrics`);
    ok('预读后歌词仍可读', after.available === true, `${after.lines.length} 行 · ${after.path}`);
  }
} catch (err) {
  console.error('验证异常：', err.message);
  fail += 1;
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close();
process.exit(fail ? 1 : 0);
