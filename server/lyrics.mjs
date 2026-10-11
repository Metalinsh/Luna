/**
 * 歌词识别与解析（设计文档 5.7）。
 *
 * 来源优先级：手动关联 > 同名 .lrc > 内嵌歌词 > 模糊匹配 .lrc > 整专辑共用 .lrc > 同名 .txt
 * 编码嗅探：BOM → 严格 UTF-8 → GB18030 → Big5 → Shift_JIS → latin1
 * 解析结果不落库，按 mtime 做内存缓存（避免用户改了 .lrc 却看到旧内容）。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import { parseFile } from 'music-metadata';

import * as store from './db.mjs';
import { probeZip, findEntry, readEntryData, splitVirtualPath } from './zip-reader.mjs';

export const LYRICS_CACHE_LIMIT = 50;
const cache = new Map(); // key: `${filePath}:${mtimeMs}` → 解析结果

/* ------------------------------------------------------------- 编码嗅探 */

/** 用内置 full-ICU 解码常见中文/日文歌词编码，无需额外依赖 */
export function sniffDecode(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');

  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'UTF-8 (BOM)' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'UTF-16LE' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'UTF-16BE' };
  }

  // 严格 UTF-8：非法序列会抛错，从而排除
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text, encoding: 'UTF-8' };
  } catch {
    /* 继续尝试其他编码 */
  }

  for (const [label, name] of [['gb18030', 'GB18030/GBK'], ['big5', 'Big5'], ['shift_jis', 'Shift_JIS']]) {
    try {
      const text = new TextDecoder(label).decode(buf);
      // 解码成功但出现大量替换字符，说明猜错了
      const bad = (text.match(/\uFFFD/g) ?? []).length;
      if (bad === 0) return { text, encoding: name };
    } catch {
      /* 尝试下一个 */
    }
  }

  return { text: new TextDecoder('latin1').decode(buf), encoding: 'Latin-1（识别可能不准确）' };
}

/* ------------------------------------------------- 字幕格式（VTT/SRT/ASS） */

/**
 * WebVTT / SRT 通用解析。
 * 两者结构几乎相同：可选序号行、`开始 --> 结束` 时间行、随后的文本行（可多行）。
 * 差别只在时间分隔符（`.` vs `,`）与 VTT 的 WEBVTT 头 / NOTE / STYLE 块。
 */
function parseTimedBlocks(raw, { isVtt = false } = {}) {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const entries = [];
  const meta = {};

  if (isVtt) {
    for (const line of lines.slice(0, 12)) {
      const m = /^([A-Za-z-]+):\s*(.+)$/.exec(line.trim());
      if (m && !/-->/.test(line)) meta[m[1].toLowerCase()] = m[2].trim();
    }
  }

  const TIME_RE = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i += 1; continue; }
    if (/^WEBVTT/i.test(line)) { i += 1; continue; }
    if (/^(NOTE|STYLE|REGION)\b/i.test(line)) {
      i += 1;
      while (i < lines.length && lines[i].trim()) i += 1;
      continue;
    }
    const m = TIME_RE.exec(line);
    if (!m) { i += 1; continue; }

    const startMs = ((Number(m[1]) * 3600) + (Number(m[2]) * 60) + Number(m[3])) * 1000
      + Number(m[4].padEnd(3, '0'));
    i += 1;
    const buf = [];
    while (i < lines.length && lines[i].trim() && !TIME_RE.test(lines[i])) {
      const t = lines[i].trim().replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim();
      if (t) buf.push(t);
      i += 1;
    }
    if (buf.length) entries.push({ time: startMs, text: buf.join(' ') });
  }

  return {
    synced: entries.length > 0,
    meta,
    offset: 0,
    lines: entries.map((e, idx) => ({ index: idx, time: e.time, text: e.text, translation: null })),
  };
}

/** ASS / SSA 解析（取 [Events] 段的 Dialogue 行） */
function parseAss(raw) {
  const lines = String(raw ?? '').replace(/\r\n?/g, '\n').split('\n');
  const meta = {};
  const entries = [];
  let inEvents = false;
  let fmt = null;

  for (const line of lines) {
    const t = line.trim();
    const sec = /^\[(.+)\]$/.exec(t);
    if (sec) { inEvents = /^events$/i.test(sec[1]); continue; }
    if (!inEvents) {
      const m = /^([A-Za-z]+):\s*(.+)$/.exec(t);
      if (m) meta[m[1].toLowerCase()] = m[2].trim();
      continue;
    }
    if (/^Format:/i.test(t)) { fmt = t.slice(7).split(',').map((s) => s.trim().toLowerCase()); continue; }
    if (!/^Dialogue:/i.test(t)) continue;

    const body = t.slice(9).trim();
    const parts = [];
    let rest = body;
    const take = fmt ? Math.max(0, fmt.length - 1) : 9;
    for (let k = 0; k < take; k += 1) {
      const idx = rest.indexOf(',');
      if (idx === -1) break;
      parts.push(rest.slice(0, idx));
      rest = rest.slice(idx + 1);
    }
    parts.push(rest);

    const startIdx = fmt ? fmt.indexOf('start') : 1;
    const textIdx = fmt ? fmt.indexOf('text') : parts.length - 1;
    const start = parts[startIdx >= 0 ? startIdx : 1] ?? '';
    const content = String(parts[textIdx >= 0 ? textIdx : parts.length - 1] ?? '')
      .replace(/\{[^}]*\}/g, '').replace(/\\N|\\n/gi, ' ').replace(/<[^>]+>/g, '').trim();

    const m = /(\d+):(\d{2}):(\d{2})[.:](\d{1,2})/.exec(start);
    if (!m || !content) continue;
    entries.push({
      time: ((Number(m[1]) * 3600) + (Number(m[2]) * 60) + Number(m[3])) * 1000
        + Number(m[4].padEnd(3, '0')),
      text: content,
    });
  }

  entries.sort((a, b) => a.time - b.time);
  return {
    synced: entries.length > 0,
    meta,
    offset: 0,
    lines: entries.map((e, idx) => ({ index: idx, time: e.time, text: e.text, translation: null })),
  };
}

/** 按扩展名选择解析器 */
export function parseSubtitle(raw, ext = '.lrc') {
  const e = String(ext).toLowerCase();
  if (e === '.vtt') return parseTimedBlocks(raw, { isVtt: true });
  if (e === '.srt') return parseTimedBlocks(raw, { isVtt: false });
  if (e === '.ass' || e === '.ssa') return parseAss(raw);
  return parseLrc(raw);
}

/* ---------------------------------------------------------------- LRC 解析 */

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_TAG = /^\[(ti|ar|al|by|offset|length|re|ve):(.*)\]$/i;

function toMs(min, sec, frac) {
  const ms = frac === undefined ? 0 : Number(String(frac).padEnd(3, '0').slice(0, 3));
  return Number(min) * 60000 + Number(sec) * 1000 + ms;
}

/**
 * 解析 LRC 文本。
 * 支持：一行多时间戳、[mm:ss.xx]/[mm:ss:xx]、[offset:±ms]、同时间戳多行（译文）、无时间轴纯文本。
 */
export function parseLrc(raw) {
  const meta = {};
  const entries = [];
  let globalOffset = 0;
  let hasTimestamp = false;

  const lines = String(raw ?? '').replace(/\r\n?/g, '\n').split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const metaMatch = META_TAG.exec(trimmed);
    if (metaMatch) {
      const key = metaMatch[1].toLowerCase();
      const value = metaMatch[2].trim();
      if (key === 'offset') globalOffset = Number(value) || 0;
      else meta[key] = value;
      continue;
    }

    TIME_TAG.lastIndex = 0;
    const stamps = [];
    let match;
    while ((match = TIME_TAG.exec(trimmed)) !== null) {
      stamps.push(toMs(match[1], match[2], match[3]));
    }
    const text = trimmed.replace(TIME_TAG, '').trim();

    if (stamps.length) {
      hasTimestamp = true;
      for (const time of stamps) entries.push({ time, text });
    } else if (text) {
      entries.push({ time: null, text });
    }
  }

  if (!hasTimestamp) {
    const plain = entries.filter((e) => e.text);
    return {
      synced: false,
      meta,
      offset: globalOffset,
      lines: plain.map((e, i) => ({ index: i, time: null, text: e.text, translation: null })),
    };
  }

  // 应用全局偏移（正值表示歌词应提前显示）
  const timed = entries
    .filter((e) => e.time !== null && e.text)
    .map((e) => ({ time: Math.max(0, e.time - globalOffset), text: e.text }))
    .sort((a, b) => a.time - b.time);

  // 同一时间戳的多行：第一行原文，其余作为译文合并
  const merged = [];
  for (const entry of timed) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.time - entry.time) < 1) {
      last.translation = last.translation ? `${last.translation}\n${entry.text}` : entry.text;
    } else {
      merged.push({ time: entry.time, text: entry.text, translation: null });
    }
  }

  return {
    synced: true,
    meta,
    offset: globalOffset,
    lines: merged.map((line, i) => ({ index: i, ...line })),
  };
}

/* ------------------------------------------------------------ 文件名匹配 */

function stripAudioExt(name) {
  return String(name).replace(/\.[a-z0-9]{1,5}$/i, '');
}

/** 归一化：去扩展名、括号统一为分隔符、去标点空格、去掉开头的音轨号 */
function normalizeForMatch(name) {
  return stripAudioExt(name)
    .toLowerCase()
    .replace(/[()[\]{}【】（）]/g, ' ')
    .replace(/^\d+[\s._\-]*/, '')
    .replace(/[\s._\-]+/g, '');
}

/** 分词：括号转空格，使 (Live) / [Remastered] 成为独立词 */
function tokenize(name) {
  return stripAudioExt(name)
    .toLowerCase()
    .replace(/[()[\]{}【】（）]/g, ' ')
    .split(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff]+/)
    .filter(Boolean);
}

function leadingNumber(name) {
  const m = /^(\d{1,3})[\s._\-]/.exec(String(name));
  return m ? Number(m[1]) : null;
}

function trailingNumber(name) {
  const m = /(\d{1,4})\s*$/.exec(stripAudioExt(name).trim());
  return m ? m[1] : null;
}

/**
 * 编号守卫：两侧都有编号且不同时，直接判为不相似。
 * 这防止 "01 Toccata.mp3" 匹配到 "02 Toccata.lrc"（会挂错歌词）。
 */
function numberConflict(a, b) {
  const la = leadingNumber(a);
  const lb = leadingNumber(b);
  if (la !== null && lb !== null && la !== lb) return true;
  const ta = trailingNumber(a);
  const tb = trailingNumber(b);
  if (ta !== null && tb !== null && ta !== tb) return true;
  return false;
}

/** 词级包含度：短名的每个词都出现在长名里 */
function tokenContainment(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let hit = 0;
  for (const token of small) if (big.has(token)) hit += 1;
  return hit / small.size;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length; const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const curr = [i];
    for (let j = 1; j <= n; j += 1) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[n];
}

/** 相似度：编号冲突直接 0；否则取「编辑距离比」与「词级包含度」的较大值 */
export function similarity(a, b) {
  if (numberConflict(a, b)) return 0;
  const x = normalizeForMatch(a);
  const y = normalizeForMatch(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const lev = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  return Math.max(lev, tokenContainment(a, b));
}

/** 支持的歌词/字幕扩展名（同步格式优先） */
const LYRIC_EXTS = ['.lrc', '.vtt', '.srt', '.ass', '.ssa', '.txt'];
/** 搜索镜像脚本目录时向上回溯的最大层数 */
const SCRIPT_UP_LEVELS = 4;
/** 这些目录不参与镜像搜索 */
const SKIP_DIRS = new Set(['.lam-undo', 'node_modules', '$recycle.bin', 'system volume information']);

/**
 * 在「镜像目录」里找字幕/台本。
 *
 * 实测结构（RJ01113481）：
 *   音频  : <发行根>/新婚妻子…/本篇（wav）/00.结婚一周年纪念日.wav
 *   台本  : <发行根>/大家一起来翻译_台本/新婚妻子…/本篇（wav）/00.结婚一周年纪念日.txt
 * 即：从音频目录逐层向上，在每一层的**兄弟目录**里按相同的相对路径去找同名脚本。
 */
async function findMirroredScript(audioDir, stem, filename) {
  let dir = audioDir;
  for (let up = 0; up < SCRIPT_UP_LEVELS; up += 1) {
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    const relFromParent = path.relative(parent, audioDir);
    let siblings;
    try {
      siblings = await fsp.readdir(parent, { withFileTypes: true });
    } catch { siblings = []; }

    for (const s of siblings) {
      if (!s.isDirectory()) continue;
      if (SKIP_DIRS.has(s.name.toLowerCase())) continue;
      if (s.name.startsWith('.')) continue;
      const sibPath = path.join(parent, s.name);
      // 跳过音频自己所在的那一支
      if (path.resolve(sibPath) === path.resolve(parent, relFromParent.split(path.sep)[0] ?? '')) continue;
      for (const ext of LYRIC_EXTS) {
        for (const name of [`${stem}${ext}`, `${filename}${ext}`]) {
          const cand = path.join(sibPath, relFromParent, name);
          try {
            const st = await fsp.stat(cand);
            if (st.isFile()) return cand;
          } catch { /* 不存在，继续 */ }
        }
      }
    }
    dir = parent;
  }
  return null;
}

/**
 * 找出该曲目的歌词/字幕文件。
 * 层级：l1 同目录同名 → l1v 完整文件名+.vtt → l2 音轨号 → l3 相似度 → script 镜像台本 → shared 整专辑 → txt 纯文本
 */
/**
 * 歌词匹配阶梯（磁盘目录与压缩包成员目录**共用同一套规则**）。
 *
 * 只依赖「同一目录下有哪些文件名」，因此两个来源的匹配口径完全一致：
 *   L1   同目录同名（同步格式优先，`.txt` 记为 txt 级）
 *   L1v  完整音频文件名 + 扩展名（实测 `01.xxx.mp3.vtt`，RJ01307571）
 *   L2   去掉音轨号前缀；或直接用音轨号命名（01.lrc / 1.lrc）
 *   L3   相似度 ≥0.8，且排除已被同专辑其它曲目精确占用的名字
 *
 * @returns {{name:string, level:string, score?:number}|null}
 */
export function matchLyricName({
  files, stem, filename, trackNo = null, claimed = new Set(),
}) {
  if (!files?.length) return null;
  const byLower = new Map(files.map((f) => [String(f).toLowerCase(), String(f)]));
  const pick = (name) => byLower.get(String(name).toLowerCase()) ?? null;
  const hasLyricExt = (f) => LYRIC_EXTS.includes(path.extname(f).toLowerCase());

  // L1：同目录同名（任意支持的扩展名，同步格式优先）
  for (const ext of LYRIC_EXTS) {
    const hit = pick(`${stem}${ext}`);
    if (hit) return { name: hit, level: ext === '.txt' ? 'txt' : 'l1' };
  }

  // L1v：完整音频文件名 + 扩展名（实测 <音频名>.wav.vtt / <音频名>.mp3.vtt）
  for (const ext of LYRIC_EXTS) {
    const hit = pick(`${filename}${ext}`);
    if (hit) return { name: hit, level: 'l1v' };
  }

  // L2：去掉音轨号前缀；或直接用音轨号命名（01.lrc / 1.lrc）
  const stripped = String(stem).replace(/^\d+[\s._\-]*/, '');
  const numbered = [stripped, trackNo != null ? String(trackNo) : null,
    trackNo != null ? String(trackNo).padStart(2, '0') : null].filter(Boolean);
  for (const candidate of numbered) {
    for (const ext of LYRIC_EXTS) {
      const hit = pick(`${candidate}${ext}`);
      if (hit) return { name: hit, level: 'l2' };
    }
  }
  const byNumber = files.find((f) => {
    if (!hasLyricExt(f)) return false;
    const n = leadingNumber(f);
    return n !== null && trackNo != null && n === Number(trackNo);
  });
  if (byNumber) return { name: byNumber, level: 'l2' };

  // L3：相似度匹配（阈值 0.8），排除已被其他曲目精确占用的文件
  let best = null;
  for (const file of files) {
    if (!hasLyricExt(file)) continue;
    if (claimed.has(file.toLowerCase())) continue;
    const score = similarity(file, stem);
    if (score >= 0.8 && (!best || score > best.score)) best = { file, score };
  }
  if (best) return { name: best.file, level: 'l3', score: best.score };

  return null;
}

/** 整专辑共用歌词：album.lrc 或与专辑同名的 .lrc（磁盘与压缩包共用） */
export function matchSharedLyric({ files, album = null }) {
  if (!files?.length) return null;
  const byLower = new Map(files.map((f) => [String(f).toLowerCase(), String(f)]));
  for (const candidate of ['album', album ?? '']) {
    if (!candidate) continue;
    for (const ext of LYRIC_EXTS) {
      const hit = byLower.get(`${candidate}${ext}`.toLowerCase());
      if (hit) return { name: hit, level: 'shared' };
    }
  }
  return null;
}

export async function findLyricsFile(track, allTracks = []) {
  const dir = track.dir ?? path.dirname(track.path);
  const filename = track.filename ?? path.basename(track.path);
  const stem = stripAudioExt(filename);
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  const byLower = new Map(files.map((f) => [f.toLowerCase(), f]));

  // L3 用：已被其他曲目精确占用的文件名
  const claimed = new Set();
  for (const other of allTracks) {
    if (other.id === track.id) continue;
    const otherBase = stripAudioExt(other.filename ?? path.basename(other.path ?? ''));
    for (const ext of LYRIC_EXTS) {
      if (byLower.has(`${otherBase}${ext}`.toLowerCase())) claimed.add(`${otherBase}${ext}`.toLowerCase());
    }
  }

  const matched = matchLyricName({ files, stem, filename, trackNo: track.track_no, claimed });
  if (matched) {
    return {
      path: path.join(dir, matched.name),
      level: matched.level,
      ...(matched.score != null ? { score: matched.score } : {}),
    };
  }

  // script：镜像目录里的台本（可能没有扩展名一致的同步格式）
  const mirrored = await findMirroredScript(dir, stem, filename);
  if (mirrored) {
    const ext = path.extname(mirrored).toLowerCase();
    return { path: mirrored, level: 'script', unsynced: ext === '.txt' };
  }

  const shared = matchSharedLyric({ files, album: track.album });
  if (shared) return { path: path.join(dir, shared.name), level: shared.level };

  return null;
}

/**
 * 压缩包成员的歌词匹配：在**同一成员目录**内按与磁盘完全相同的阶梯找。
 *
 * 纯计算（只读 `archive_members` 清单），不解压任何数据；真正的读取交给
 * `readArchiveLyricsMember()` —— 预读过的直接读缓存文件，没预读的现场解出这一个成员。
 *
 * @returns {{memberPath:string, level:string, score?:number}|null}
 */
export function findArchiveLyricsMember(track, allTracks = []) {
  const archiveId = Number(track?.archive_id);
  const memberPath = String(track?.member_path ?? splitVirtualPath(track?.path)?.memberPath ?? '')
    .replace(/\\/g, '/');
  if (!archiveId || !memberPath) return null;
  const dir = path.posix.dirname(memberPath);
  const filename = path.posix.basename(memberPath);
  const stem = stripAudioExt(filename);

  const inDir = (p) => path.posix.dirname(String(p).replace(/\\/g, '/')) === dir;
  const files = store.listArchiveMembers(archiveId)
    .map((m) => String(m.member_path ?? '').replace(/\\/g, '/'))
    .filter((p) => p && p !== memberPath && inDir(p))
    .map((p) => path.posix.basename(p));
  if (!files.length) return null;

  const byLower = new Set(files.map((f) => f.toLowerCase()));
  const claimed = new Set();
  for (const other of allTracks ?? []) {
    if (other.id === track.id || Number(other.archive_id) !== archiveId) continue;
    const otherName = String(other.member_path ?? '').replace(/\\/g, '/');
    if (!inDir(otherName)) continue;
    const otherStem = stripAudioExt(path.posix.basename(otherName));
    for (const ext of LYRIC_EXTS) {
      const candidate = `${otherStem}${ext}`.toLowerCase();
      if (byLower.has(candidate)) claimed.add(candidate);
    }
  }

  const matched = matchLyricName({ files, stem, filename, trackNo: track.track_no, claimed })
    ?? matchSharedLyric({ files, album: track.album });
  if (!matched) return null;
  return {
    memberPath: dir === '.' ? matched.name : `${dir}/${matched.name}`,
    level: matched.level,
    ...(matched.score != null ? { score: matched.score } : {}),
  };
}

/** 内嵌歌词（ID3 USLT/SYLT、Vorbis LYRICS、MP4 ©lyr） */
export async function readEmbeddedLyrics(filePath) {  try {
    const { common } = await parseFile(filePath, { duration: false, skipCovers: true });
    const lyrics = common.lyrics;
    if (!Array.isArray(lyrics) || !lyrics.length) return null;

    const withSync = lyrics.find((l) => Array.isArray(l.syncText) && l.syncText.length);
    if (withSync) {
      const text = withSync.syncText
        .map((s) => `[${String(Math.floor((s.timestamp ?? 0) / 60000)).padStart(2, '0')}:`
          + `${String(Math.floor(((s.timestamp ?? 0) % 60000) / 1000)).padStart(2, '0')}.`
          + `${String((s.timestamp ?? 0) % 1000).padStart(3, '0')}]${s.text ?? ''}`)
        .join('\n');
      return { raw: text, encoding: '内嵌（同步歌词）' };
    }
    const plain = lyrics.find((l) => l.text);
    if (plain) return { raw: plain.text, encoding: '内嵌（非同步）' };
    return null;
  } catch {
    return null;
  }
}

/**
 * 读取压缩包内的歌词成员。
 *
 * 优先读**预读过的缓存文件**（预读专辑时歌词一并落盘，打开歌词零解压）；
 * 没预读的则现场解出这一个成员 —— 歌词只有几十 KB，代价可忽略，
 * 因此「不预读也能看到歌词」，预读只是让它更快。
 */
export async function readArchiveLyricsMember(track, found) {
  const archiveId = Number(track?.archive_id);
  const memberPath = found?.memberPath;
  if (!archiveId || !memberPath) return null;
  const level = found.level ?? 'l1';

  const empty = (error) => ({
    available: false, source: null, level: null, path: memberPath,
    encoding: null, synced: false, meta: {}, lines: [], ...(error ? { error } : {}),
  });

  const archive = store.getArchiveById(archiveId);
  if (!archive) return empty('ARCHIVE_MISSING');

  // 1) 已预读：直接走缓存文件（沿用 mtime 内存缓存与解析器选择）
  const entry = store.getCacheEntry(archiveId, memberPath);
  if (entry?.file_path) {
    try {
      await fsp.access(entry.file_path);
      store.touchCacheEntry(archiveId, memberPath);
      const cached = await readLyricsFile(entry.file_path, 'archive', level);
      if (cached.available) return cached;
    } catch { /* 缓存文件不在 / 读失败 → 走现场解压 */ }
  }

  // 2) 现场解出该成员
  try {
    const info = await probeZip(archive.path);
    const member = findEntry(info.entries, memberPath);
    if (!member) return empty('MEMBER_MISSING');
    const buffer = await readEntryData(archive.path, member);
    const { text, encoding } = sniffDecode(buffer);
    const ext = path.posix.extname(memberPath).toLowerCase();
    const parsed = parseSubtitle(text, ext);
    const format = ['.vtt', '.srt', '.ass', '.ssa', '.lrc'].includes(ext) ? ext.slice(1) : 'txt';
    return {
      available: parsed.lines.length > 0,
      source: 'archive',
      level,
      path: memberPath,
      encoding,
      format,
      ...parsed,
    };
  } catch (err) {
    return empty(err.code ?? err.message);
  }
}

/* -------------------------------------------------------------- 主入口 */

/**
 * 取某曲目的歌词。返回：
 * { available, source, level, path, encoding, synced, meta, lines, error }
 */
export async function getLyricsForTrack(track, allTracks = []) {
  if (!track) throw new Error('曲目不存在');

  // 手动关联优先
  if (track.lyrics_path) {
    const result = await readLyricsFile(track.lyrics_path, 'manual');
    if (result.available) return result;
  }

  /*
   * 压缩包成员：磁盘那套 readdir 对虚拟路径无效（成员不在文件系统里）。
   * 因此在磁盘匹配之前，先按**包内成员清单**走同一套阶梯匹配，
   * 命中后读缓存文件或现场解出该成员。
   */
  const isVirtualMember = track.source_kind === 'archive_member'
    && String(track.path ?? '').includes('\u0000');
  if (isVirtualMember) {
    const found = findArchiveLyricsMember(track, allTracks);
    if (found) {
      const result = await readArchiveLyricsMember(track, found);
      if (result?.available) return result;
    }
  }

  const found = await findLyricsFile(track, allTracks);
  if (found) {
    const result = await readLyricsFile(found.path, found.level === 'txt' ? 'txt' : 'lrc', found.level);
    if (result.available) return result;
  }

  /*
   * 内嵌歌词：压缩包成员要先落到缓存才能解析。
   * 预读过的曲目因此也能用上包内曲目的内嵌歌词（此前一律读不到）。
   */
  let embeddedPath = track.path;
  if (isVirtualMember && track.archive_id && track.member_path) {
    const entry = store.getCacheEntry(track.archive_id, track.member_path);
    if (entry?.file_path) embeddedPath = entry.file_path;
  }
  const embedded = await readEmbeddedLyrics(embeddedPath);
  if (embedded) {
    const parsed = parseLrc(embedded.raw);
    return {
      available: true,
      source: 'embedded',
      level: 'embedded',
      path: null,
      encoding: embedded.encoding,
      ...parsed,
    };
  }

  return {
    available: false,
    source: null,
    level: null,
    path: null,
    encoding: null,
    synced: false,
    meta: {},
    lines: [],
  };
}

async function readLyricsFile(filePath, source, level = 'l1') {
  try {
    const stat = await fsp.stat(filePath);
    const key = `${filePath}:${stat.mtimeMs}`;
    const cached = cache.get(key);
    if (cached) return { ...cached, source, level };

    const buffer = await fsp.readFile(filePath);
    const { text, encoding } = sniffDecode(buffer);
    // 按扩展名选择解析器：.vtt / .srt / .ass / .ssa / .lrc / 其它当纯文本
    const ext = path.extname(filePath).toLowerCase();
    const parsed = parseSubtitle(text, ext);
    const format = ['.vtt', '.srt', '.ass', '.ssa', '.lrc'].includes(ext) ? ext.slice(1) : 'txt';
    const result = {
      available: parsed.lines.length > 0,
      source,
      level,
      path: filePath,
      encoding,
      format,
      ...parsed,
    };

    cache.set(key, result);
    if (cache.size > LYRICS_CACHE_LIMIT) {
      cache.delete(cache.keys().next().value);
    }
    return result;
  } catch (err) {
    return {
      available: false,
      source: null,
      level: null,
      path: filePath,
      encoding: null,
      synced: false,
      meta: {},
      lines: [],
      error: `${err.code ?? err.message}`,
    };
  }
}

export function clearLyricsCache() {
  cache.clear();
}
