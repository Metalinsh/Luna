/**
 * 音声（ASMR）发行结构解析（设计文档《音声专辑设计》R1–R15）。
 *
 * 纯路径/文件名推导，不依赖音频标签；标签只用于「标题校对」与「冲突检测」。
 * 后续扫描器与界面都以此为唯一事实来源。
 */
import fs from 'node:fs';
import path from 'node:path';

import { parseFile } from 'music-metadata';

/* ------------------------------------------------------------------ 常量 */

export const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wma', '.aiff', '.aif']);
export const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.m4v', '.mov', '.avi']);

/** R7：这些目录整棵子树不收录 */
const IGNORE_PATTERNS = [
  /闹钟/, /目覚まし/, /alarm/i, /动态壁纸/, /live\s*photos?/i, /livephoto/i,
  /促销/, /宣传/, /promo/i, /试听/, /サンプル/, /sample/i,
];

/** R8：归入特典分组的标记 */
const BONUS_PATTERNS = [/特典/, /おまけ/, /おまけ/, /bonus/i, /extra/i, /(^|[^a-z])ex([^a-z]|$)/i];

/** R2：格式包装目录的格式词 */
const FORMAT_WORDS = ['mp3', 'wav', 'flac', 'aiff', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'video', '视频', '動画', '動画', '形式'];
/** 参数类词（出现在格式目录名里但不构成版本名） */
const PARAM_WORDS = ['kbps', 'khz', 'bit', 'hz'];

const RJ_PATTERN = /RJ\s*\d{6,8}/i;

/* -------------------------------------------------------------- 文本工具 */

/** 全角转半角 + 去首尾空白 */
export function toHalfWidth(s) {
  return String(s ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .trim();
}

/** 用于「是否同一版本」的宽松键：小写、去标点与空白 */
export function looseKey(s) {
  return toHalfWidth(s)
    .toLowerCase()
    .replace(/[（）()［］\[\]【】{}「」『』、。，．,.\-_:：;；+＋/／\\|~～〜!！?？'"”“'']/g, '')
    .replace(/\s+/g, '');
}

const stripExt = (name) => String(name).replace(/\.[a-z0-9]{1,5}$/i, '');

/**
 * 基名归一化：去掉真实扩展名后，再去掉发布者偶尔重复写在尾部的格式词。
 * 实测样本：`02_…彗の乳首責めwav.wav`（5 个文件），扩展名才是格式的权威来源。
 * 压缩包样本：`…早漏訓練（バイノーラル編集　効果音あり）.mp3`（包内 4 份同轨副本）。
 */
export function baseNameOf(fileName) {
  const base = stripExt(fileName);
  // 只在「尾部」剥格式词，避免误伤 `trackEX_每周一次…` 这类以 EX 开头的正常标题。
  // 先尝试 `_格式` / `-格式` / 空格+格式 的整段尾巴，再退回裸格式词。
  const tail = base.match(/^(.*?)(?:[\s_\-](mp3|wav|flac|aiff|m4a|aac|ogg|opus|wma))$/i);
  if (tail && tail[1].length >= 2) return tail[1];
  const bare = base.match(/^(.*?)(mp3|wav|flac|aiff|m4a|aac|ogg|opus|wma)$/i);
  if (bare && bare[1].length >= 2) return bare[1];
  return base;
}

/* ------------------------------------------------------------ R1 发行根 */

/**
 * 把路径拆成「归档根 + 成员路径」两级段落。
 * 普通路径：archive = null，members = 各目录段。
 * 虚拟路径：archive = 压缩包路径，members = 包内成员段（NUL 之后）。
 */
function pathLayers(filePath) {
  const s = String(filePath);
  const i = s.indexOf('\u0000');
  const archive = i >= 0 ? s.slice(0, i) : null;
  const rest = i >= 0 ? s.slice(i + 1) : (archive === null ? s : '');
  const members = rest.split(/[\\/]/).filter(Boolean);
  const archiveSegs = archive === null ? [] : archive.split(/[\\/]/).filter(Boolean);
  return { archive, archiveSegs, members, isVirtual: i >= 0 };
}

/** 定位发行根：路径中最靠外的 RJ 号（压缩包感知，见上方说明） */
export function locateRelease(filePath) {
  const { archive, archiveSegs, members, isVirtual } = pathLayers(filePath);
  const codes = [];
  for (let i = 0; i < archiveSegs.length; i += 1) {
    const m = RJ_PATTERN.exec(archiveSegs[i]);
    if (m) codes.push({ layer: 'archive', index: i, code: m[0].toUpperCase().replace(/\s/g, '') });
  }
  for (let i = 0; i < members.length; i += 1) {
    const m = RJ_PATTERN.exec(members[i]);
    if (m) codes.push({ layer: 'member', index: i, code: m[0].toUpperCase().replace(/\s/g, '') });
  }
  if (!codes.length) return null;

  const first = codes[0];
  // 发行根 = 从头到「最外层 RJ 所在段」的完整路径；压缩包边界原样保留。
  const releaseRoot = first.layer === 'archive'
    ? archiveSegs.slice(0, first.index + 1).join(path.sep)
    : `${archiveSegs.join(path.sep)}${isVirtual ? '\u0000' : ''}${members.slice(0, first.index + 1).join(path.sep)}`;

  return {
    rjCode: first.code,
    releaseRoot,
    releaseFolderName: first.layer === 'archive' ? archiveSegs[first.index] : members[first.index],
    nestedRjCodes: [...new Set(codes.slice(1).map((h) => h.code))],
    /** 发行根之后的路径段（含文件名） */
    tail: members.slice(first.layer === 'member' ? first.index + 1 : 0),
  };
}

/** 从发行根目录名里剥掉 [RJxxxxxxxx] 前缀，得到标题候选 */
export function titleFromFolder(folderName) {
  return toHalfWidth(String(folderName).replace(/^\[?\s*RJ\s*\d{6,8}\s*\]?/i, '').trim())
    .replace(/^[_\-–—\s:：]+/, '')
    .trim();
}

/* ---------------------------------------------------- R2/R3 版本目录识别 */

/** R7：该目录是否应被忽略 */
export function isIgnoredSegment(name) {
  const n = toHalfWidth(name);
  return IGNORE_PATTERNS.some((re) => re.test(n));
}

/** R8：该目录是否属于特典分组 */
export function isBonusSegment(name) {
  const n = toHalfWidth(name);
  return BONUS_PATTERNS.some((re) => re.test(n));
}

/** R2：是否是「纯格式包装目录」 */
export function isFormatWrapperDir(name) {
  const raw = toHalfWidth(name);
  const n = raw.toLowerCase();
  if (!n) return false;
  // 视频目录一律视为格式包装（如 04_带字幕的音频视频）
  if (/视频|動画|video/.test(n)) return true;
  if (!FORMAT_WORDS.some((w) => n.includes(w))) return false;

  let rest = n;
  for (const w of FORMAT_WORDS) rest = rest.split(w).join('');
  rest = rest.replace(/（[^）]*）|\([^)]*\)/g, '');
  for (const w of PARAM_WORDS) rest = rest.split(w).join('');
  rest = rest.replace(/[\d\s:：_\-.]+/g, '');
  // 允许残留极少字符（如「带字幕的」已被视频规则拦下）
  return rest.length <= 1;
}

/** R2：判断某段是否只是专辑名的重复包装（忽略 RJ 前缀、扩展名与社团名差异） */
function isAlbumWrapper(segment, title) {
  const core = (s) => looseKey(
    String(s ?? '').replace(RJ_PATTERN, '').replace(/\.[a-z0-9]{1,5}$/i, ''),
  );
  const a = core(segment);
  const b = core(title);
  if (!a || !b || b.length < 4) return false;
  // 逐级包含任一方向都视为包装：
  //   · a 含 b —— 压缩包里唯一顶层目录常写作「作品名 + 版本名」的连写；
  //   · b 含 a —— 目录只写作品名、而发行根带了社团名（[RJ…][社团]作品名/作品名/…）。
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * 发行根 → 作品名候选：剥掉 `[RJxxxxxxxx]` 前缀。
 *
 * 压缩包的发行根是 `.zip` 本身，要先剥扩展名；且虚拟路径带 NUL 分隔符，
 * 不能用 path.posix.basename —— 那会取到路径里那一段「ASMR」而不是包名。
 */
export function releaseTitleOf(rootDir) {
  const s = String(rootDir ?? '');
  const nul = s.indexOf('\u0000');
  const base = nul >= 0 ? s.slice(0, nul) : s;
  return titleFromFolder(path.basename(base).replace(/\.(zip|7z|rar|tar|gz|iso)$/i, ''));
}

/** R3：版本名归一化（去掉格式标记与参数） */
export function normalizeVersionName(raw) {
  let n = toHalfWidth(raw);
  // 只剥「独立出现」的格式标记：后面不能再跟字母数字或汉字，
  // 否则会把「03_仅mp3版」这类版本名里的 mp3 误删
  n = n.replace(/[_\-]?(mp3|wav|flac|aiff|m4a|aac|ogg|opus|wma)(?![a-z0-9\u4e00-\u9fff])/gi, '');
  n = n.replace(/(mp3|wav|flac)\s*(形式|format)/gi, '');
  n = n.replace(/\b\d{2,3}\s*kbps\b/gi, '').replace(/\b\d{2,3}\s*khz\b/gi, '');
  n = n.replace(/（\s*）|\(\s*\)/g, '');
  n = n.replace(/\s{2,}/g, ' ');
  return n.replace(/^[_\-:：\s]+|[_\-:：\s]+$/g, '').trim();
}

/**
 * 剥离「纯专辑名包装段」：例如压缩包里唯一顶层目录就叫作品名。
 * 只从**开头**连续剥离，一旦遇到真正的版本段就停止——
 * 否则会把「作品名 + 版本名」连写的段整段丢掉，版本信息就没了。
 */
function stripWrapperSegments(segments, releaseTitle) {
  let i = 0;
  while (i < segments.length && isAlbumWrapper(segments[i], releaseTitle)) i += 1;
  return segments.slice(i);
}

/**
 * R2 主函数：从「发行根之后的目录链」推出该文件所属的版本目录链
 * 返回 { segments, name, group }
 */
export function resolveVersion(tailSegments, releaseTitle) {
  const dirs = tailSegments.slice(0, -1);          // 末段是文件名
  const kept = [];
  let bonus = false;
  let inVideoWrapper = false;
  let videoVariant = null;

  for (const seg of dirs) {
    if (isIgnoredSegment(seg)) return { ignored: true, reason: `忽略目录：${seg}` };
    if (isBonusSegment(seg)) { bonus = true; continue; }   // 特典标记不参与版本名，但标记分组
    if (isFormatWrapperDir(seg)) {
      if (/视频|動画|video/i.test(toHalfWidth(seg))) inVideoWrapper = true;
      continue;
    }
    // 视频目录下的子目录是「视频子变体」（如「有日文字幕」），不构成新版本（R6）
    if (inVideoWrapper) { videoVariant = videoVariant ?? toHalfWidth(seg); continue; }
    kept.push(seg);
  }

  const cleaned = stripWrapperSegments(kept, releaseTitle);
  // 压缩包：发行根本身（`<包名>.zip`）也会作为一段出现，它不构成版本
  const versionSegs = cleaned.filter((s) => !/\.(zip|7z|rar|tar|gz|iso)$/i.test(s));
  const rawName = versionSegs.length ? versionSegs[versionSegs.length - 1] : '本篇';
  return {
    ignored: false,
    bonus,
    videoVariant,
    segments: versionSegs,
    name: normalizeVersionName(rawName) || '本篇',
  };
}

/**
 * 从文件名括号里提取「该文件的差分标记」，用于区分同一版本里的多个变体。
 *
 * 实测场景：`无饮尿（wav）` 目录下第 6 轨有两个文件
 *   `06.…（无音效、无饮尿）.wav` 与 `06.…（无饮尿）.wav`
 * 两者同属「无饮尿」版本、轨道键也相同，若不区分，界面上会出现两个同名版本。
 *
 * @returns {string|null} 例如「无音效 无饮尿」；与版本名等价或与已知标记无关时返回 null
 */
export function fileVariantLabel(fileName, versionName, variantTokens = []) {
  const base = baseNameOf(fileName);
  const inside = [...base.matchAll(/[（(]([^）)]*)[)）]/g)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  if (!inside.length) return null;

  const label = inside.join('、')
    .replace(/[、，,／/]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!label) return null;

  const a = looseKey(label);
  const b = looseKey(versionName);
  if (!a) return null;
  // 与版本名等价（或只是版本名的一部分）→ 不必重复显示
  if (a === b || b.includes(a)) return null;

  // 必须与「已知的差分标记词」相关，避免把「（前篇）」这类标题残留当成版本
  const related = variantTokens.some((t) => {
    const k = looseKey(t);
    return k && (a.includes(k) || k.includes(a));
  });
  return related ? label : null;
}

/* ------------------------------------------------------ R9/R10 轨道识别 */

/** R9：从文件名提取轨道序号 */
export function extractTrackNo(fileName) {
  const base = stripExt(fileName);
  let m = /^(\d{1,3})[._\-\s]/.exec(base);
  if (m) return { no: Number(m[1]), prefix: m[0] };
  m = /^track\s*(\d{1,3})[._\-\s]/i.exec(base);
  if (m) return { no: Number(m[1]), prefix: m[0] };
  if (/^EP[._\-\s]/i.test(base)) return { no: 9999, prefix: base.slice(0, 3) };
  return { no: null, prefix: '' };
}

/** 从版本名里提取「差分标记词」（用于从文件名里剔除） */
export function variantTokensOf(versionName) {
  const tokens = toHalfWidth(versionName)
    .split(/[（()）_+\s:：]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t) && !/^(ver|version|通常)$/i.test(t));
  // 「01_通常ver」→ 只保留 通常ver
  return [...new Set(tokens)];
}

/**
 * R10：轨道键 —— 去掉序号前缀、差分标记词、被清空的括号与分隔符
 */
export function trackKeyOf(fileName, variantTokens = []) {
  let base = baseNameOf(fileName);
  const { prefix } = extractTrackNo(fileName);
  if (prefix) base = base.slice(prefix.length);

  for (const token of variantTokens) {
    if (!token) continue;
    const re = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    base = base.replace(re, '');
  }
  base = base
    .replace(/[（(]\s*[)）]/g, '')          // 清空被掏空的括号
    .replace(/[_+\-]{2,}/g, '_')
    .replace(/^[_+\-\s:：]+|[_+\-\s:：]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return looseKey(base) || looseKey(stripExt(fileName));
}

/** 括号配平：丢掉不配对的括号（差分词被剔除后常留下落单的「）」） */
function balanceBrackets(s) {
  let depth = 0;
  let out = '';
  for (const ch of String(s)) {
    if (ch === '（' || ch === '(') { depth += 1; out += ch; } else if (ch === '）' || ch === ')') {
      if (depth > 0) { depth -= 1; out += ch; }
    } else out += ch;
  }
  return out;
}

/** 显示用轨道标题 */
export function displayTitleOf(fileName, variantTokens = []) {
  let base = baseNameOf(fileName);
  const { prefix } = extractTrackNo(fileName);
  if (prefix) base = base.slice(prefix.length);
  for (const token of variantTokens) {
    if (!token) continue;
    const re = new RegExp(`[（(]?\\s*${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[)）]?`, 'gi');
    base = base.replace(re, '');
  }
  base = balanceBrackets(base)
    .replace(/[（(]\s*[)）]/g, '')
    .replace(/[_+\-]{2,}/g, '_')
    .replace(/^[_+\-\s:：、，,]+|[_+\-\s:：、，,]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return base || stripExt(fileName);
}

/* ------------------------------------------------ R10+ 相似度合并（1+3 策略） */

/** 编辑距离相似度 */
function editSimilarity(a, b) {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const curr = [i];
    for (let j = 1; j <= n; j += 1) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/** 数字签名：两个键的数字序列不同 → 绝不合并（DAY01_01 与 DAY01_02 是两条轨道） */
const digitSignature = (key) => (key.match(/\d+/g) ?? []).join(',');

/** 篇章标记：一侧有「前篇」另一侧有「后篇」时，它们本来就是两条不同的轨道 */
const PART_MARKERS = ['前篇', '后篇', '前編', '後編', '上巻', '下巻', '上集', '下集', 'part', 'その'];
function differsByPartMarker(a, b) {
  const pick = (k) => PART_MARKERS.filter((t) => k.includes(t));
  const ta = pick(a);
  const tb = pick(b);
  return ta.length > 0 && tb.length > 0 && ta.join('|') !== tb.join('|');
}

const MERGE_CONTAIN_RATIO = 0.6;   // 包含关系下，短键/长键的最小占比
const MERGE_AUTO_SIMILARITY = 0.9; // 编辑距离比达到此值即可自动合并
const MERGE_PENDING_SIMILARITY = 0.82; // 低于自动阈值但达到此值 → 进「待确认」

/**
 * 按相似度合并轨道行（规则 R10+）：
 *   - 数字签名不同 → 直接不合并
 *   - 包含关系且占比足够，且（来自不同版本 或 多出的部分是已知差分标记）→ 自动合并
 *   - 编辑距离很高且来自不同版本 → 自动合并
 *   - 其余相似但不够把握 → 记入 mergeCandidates，交由人工确认
 */
function mergeSimilarRows(trackRows, uniqueTokens, decisions = { merge: [], separate: [] }) {
  const rows = [...trackRows.values()];
  const mergeCandidates = [];
  const pairKey = (x, y) => [x, y].sort().join('\u0000');
  const forcedMerge = new Set((decisions.merge ?? []).map(([x, y]) => pairKey(x, y)));
  const forcedSeparate = new Set((decisions.separate ?? []).map(([x, y]) => pairKey(x, y)));

  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i];
      const b = rows[j];
      if (!trackRows.has(a.key) || !trackRows.has(b.key)) continue;
      if (a.isBonus !== b.isBonus) continue;          // 主轨道与特典不互相合并

      const pair = pairKey(a.key, b.key);
      if (forcedSeparate.has(pair)) continue;         // 人工已判定「不同轨」
      const mustMerge = forcedMerge.has(pair);        // 人工已判定「同一条轨」

      if (!mustMerge) {
        if (digitSignature(a.key) !== digitSignature(b.key)) continue;
        if (differsByPartMarker(a.key, b.key)) continue;   // 前篇/后篇 之类 → 本就是不同轨道
      }

      const short = a.key.length <= b.key.length ? a.key : b.key;
      const long = a.key.length <= b.key.length ? b.key : a.key;
      if (short.length < 3) continue;   // 太短的键（如单字）不参与合并，避免误合

      const contained = long.includes(short);
      const ratio = short.length / long.length;
      const lev = editSimilarity(a.key, b.key);
      const versionsDiffer = !a.versions.some((va) => b.versions.some((vb) => vb.versionKey === va.versionKey));
      const leftover = contained ? long.replace(short, '') : '';
      const leftoverIsVariant = Boolean(leftover)
        && uniqueTokens.some((t) => t.includes(leftover) || leftover.includes(t));

      const autoContain = contained && ratio >= MERGE_CONTAIN_RATIO
        && (versionsDiffer || leftoverIsVariant);
      const autoNear = lev >= MERGE_AUTO_SIMILARITY && versionsDiffer;

      if (mustMerge || autoContain || autoNear) {
        const keep = a.key === short ? a : b;
        const drop = a.key === short ? b : a;
        keep.versions.push(...drop.versions);
        keep.hasVideo = keep.hasVideo || drop.hasVideo;
        if (keep.trackNo == null) keep.trackNo = drop.trackNo;
        keep.mergedTitles = [...(keep.mergedTitles ?? []), drop.title];
        if (drop.conflict) keep.conflict = true;
        trackRows.delete(drop.key);
        continue;
      }

      if (contained || lev >= MERGE_PENDING_SIMILARITY) {
        mergeCandidates.push({
          a: { title: a.title, key: a.key, versions: a.versions.map((v) => v.versionName) },
          b: { title: b.title, key: b.key, versions: b.versions.map((v) => v.versionName) },
          contained,
          ratio: Number(ratio.toFixed(2)),
          similarity: Number(lev.toFixed(2)),
          reason: contained ? '一个标题包含另一个' : '标题高度相似',
        });
      }
    }
  }
  return mergeCandidates;
}

/**
 * 从曲目艺术家标签里取「多数票」。
 * 音声作品的 artist 标签最贴近实际演出者，识别艺术家时以它为准。
 */
export function pickTrackArtist(artists = []) {
  const counts = new Map();
  for (const raw of artists) {
    const v = String(raw ?? '').trim();
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  if (!counts.size) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

/* ------------------------------------------------------------ 发行解析 */

function walkFiles(root) {
  const out = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      const ext = path.extname(e.name).toLowerCase();
      const kind = AUDIO_EXT.has(ext) ? 'audio' : VIDEO_EXT.has(ext) ? 'video' : 'other';
      let size = 0;
      try { size = fs.statSync(full).size; } catch { /* 忽略 */ }
      out.push({ path: full, name: e.name, ext, kind, size });
    }
  }(root));
  return out;
}

/**
 * 发行根 → 成员相对路径（**压缩包安全**）。
 *
 * 不能用 path.relative()：虚拟路径里含有 NUL 分隔符，Windows 上 path.relative()
 * 在解析到 NUL 时返回 '..'，会让整个三-层模型退化成「无版本」。
 * 这里改为纯字符串前缀裁剪，并把分隔符统一成 /，与 path.posix 系列配合使用。
 *
 * 还要在 NUL 处再切一刀：压缩包的虚拟路径是 `<包路径>\0<成员路径>`，
 * 切开后「压缩包本身」成为发行根之后的**第一个目录段**，
 * 于是包内唯一的顶层包装目录能被 R2 的专辑名包装规则正常识别。
 */
function relOf(rootDir, filePath) {
  const root = String(rootDir);
  let s = String(filePath);
  // 三种边界都要认：普通目录用 \ 或 /，压缩包虚拟路径用 NUL（`<包路径>\0<成员路径>`）
  for (const sep of [path.sep, '/', '\u0000']) {
    if (s.startsWith(`${root}${sep}`)) { s = s.slice(root.length + 1); break; }
  }
  return s
    .split('\u0000')
    .flatMap((part) => part.split(/[\\/]/))
    .filter((x) => x.length > 0);
}

/** 相对路径段 → 显示用的相对路径（统一 / 分隔，压缩包与目录都直观） */
function relText(segments) {
  return segments.join('/');
}

const COVER_DIR_HINTS = [/高画质封面/, /封面/, /^cover/i];
/** 封面文件名优先级：先包装图，再封面，最后插图（同级内按文件名自然序取第一张） */
const COVER_NAME_PRIORITY = [
  [/package/i, /封装/, /パッケージ/, /表紙/, /jacket/i],
  [/cover/i, /封面/],
  [/artwork/i, /イラスト/, /illust/i],
];
const naturalByName = (a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true });

/** R13：在发行根内挑封面 */
export function pickCover(files) {
  const images = files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f.name));
  if (!images.length) return null;

  const inCoverDir = images.filter((f) => {
    const parts = f.path.split(/[\\/]/);
    return parts.some((p) => COVER_DIR_HINTS.some((re) => re.test(p)));
  });
  const pool = inCoverDir.length ? inCoverDir : images;

  for (const group of COVER_NAME_PRIORITY) {
    const hit = pool.filter((f) => group.some((re) => re.test(f.name)));
    if (hit.length) return [...hit].sort(naturalByName)[0];
  }
  if (inCoverDir.length) return [...inCoverDir].sort(naturalByName)[0];
  return [...images].sort((a, b) => b.size - a.size)[0];
}

/**
 * 解析一个发行目录，返回结构化结果（不写数据库）。
 * opts.readTags=true 时读取标签用于标题校对与冲突检测（较慢）。
 *
 * opts.files：**外部注入的成员清单**（压缩包支持用，见 docs/压缩包支持设计.md §4.2）。
 * 传入时不再遍历磁盘，`path` 允许是虚拟路径；其余逻辑与目录扫描完全一致，
 * 因此音声三层模型、版本规则、特典分离、差分标注对压缩包同样成立。
 */
export async function analyzeRelease(rootDir, {
  readTags = true, maxTagReads = 40, decisions = null, files: injected = null,
} = {}) {
  const files = injected ?? walkFiles(rootDir);
  // 压缩包：发行根是 .zip 文件本身，标题要剥掉 .zip 才是作品名（虚拟路径带 NUL，不能用 posix.basename）
  const releaseTitle = releaseTitleOf(rootDir);

  // R1：发行根之内若还出现别的 RJ 号目录，视为「特典子发行」，标记但不单独成卡
  const ownRj = locateRelease(rootDir)?.rjCode ?? null;
  const nestedRjCodes = new Set();
  for (const f of files) {
    for (const seg of relOf(rootDir, f.path)) {
      const m = RJ_PATTERN.exec(seg);
      const code = m ? m[0].toUpperCase().replace(/\s/g, '') : null;
      if (code && code !== ownRj) nestedRjCodes.add(code);
    }
  }

  const versions = new Map();   // key → version
  const trackRows = new Map();  // trackKey → row
  const ignored = [];
  let tagReads = 0;
  const tagTitles = [];
  /** 全部曲目的 artist 标签（含重复，用于投多数票） */
  const tagArtists = [];
  /** 专辑艺术家标签（albumartist），仅作校验/建议 */
  let albumArtistFromTag = null;
  let taggedAlbum = null;

  for (const f of files) {
    if (f.kind === 'other') continue;
    const segments = relOf(rootDir, f.path);

    const v = resolveVersion(segments, releaseTitle);
    if (v.ignored) { ignored.push({ path: relText(segments), reason: v.reason }); continue; }

    const format = f.kind === 'video' ? 'video' : f.ext.replace('.', '');
    const key = `${v.bonus ? 'bonus:' : ''}${looseKey(v.name)}`;

    if (!versions.has(key)) {
      versions.set(key, {
        key, name: v.name, group: v.bonus ? 'bonus' : 'main',
        formats: new Set(), dir: path.posix.dirname(relText(segments)),
        fileCount: 0, bytes: 0, files: new Map(),
      });
    }
    const version = versions.get(key);
    version.formats.add(format);
    version.fileCount += 1;
    version.bytes += f.size;

    // 标签（仅音频、限量）
    if (readTags && f.kind === 'audio' && tagReads < maxTagReads) {
      tagReads += 1;
      try {
        const m = await parseFile(f.path, { duration: false, skipCovers: true });
        if (m.common.album && !taggedAlbum) taggedAlbum = m.common.album;
        // 曲目艺术家（artist）与专辑艺术家（albumartist）分开收集：
        // 识别艺术家时以 artist 为准，albumartist 只作为「建议」用于校验
        if (m.common.albumartist && !albumArtistFromTag) {
          albumArtistFromTag = String(m.common.albumartist).trim() || null;
        }
        const tr = String(m.common.artist ?? '').trim();
        if (tr) tagArtists.push(tr);
        if (m.common.title) tagTitles.push(m.common.title);
      } catch { /* 标签读取失败不影响结构 */ }
    }

    // 同一轨道键下要保留「全部」文件（同一轨可能有 mp3/wav/视频多个文件）
    const tk = trackKeyOf(f.name, []);
    if (!version.files.has(tk)) version.files.set(tk, []);
    version.files.get(tk).push({
      file: f,
      trackNo: extractTrackNo(f.name).no,
      // 视频目录下的子目录（如「有日文字幕」）作为该视频变体的标签
      variantLabel: f.kind === 'video' ? (v.videoVariant ?? null) : null,
    });
  }

  /* R5：按版本套用 wav 优先 —— 先算出差分标记词，再重算轨道键 */
  const allTokens = [...versions.values()].flatMap((v) => variantTokensOf(v.name));
  const uniqueTokens = [...new Set(allTokens)].sort((a, b) => b.length - a.length);

  for (const version of versions.values()) {
    version.isVideo = version.formats.size === 1 && version.formats.has('video');
    version.trackKeys = new Set();
    for (const list of version.files.values()) {
      for (const rec of list) {
        const fixed = trackKeyOf(rec.file.name, uniqueTokens);
        version.trackKeys.add(fixed);
        rec.trackKey = fixed;
        if (!trackRows.has(fixed)) {
          trackRows.set(fixed, {
            key: fixed,
            trackNo: rec.trackNo,
            title: displayTitleOf(rec.file.name, uniqueTokens),
            versions: [],
            hasVideo: false,
            isBonus: version.group === 'bonus',
          });
        }
        const row = trackRows.get(fixed);
        if (rec.trackNo != null && row.trackNo == null) row.trackNo = rec.trackNo;
        // 音频：同一版本里若同一轨有多个文件，用文件名括号里的差分标记区分
        // （视频沿用目录名作为标签，如「有日字幕」）
        const label = rec.variantLabel
          ?? (rec.file.kind === 'video'
            ? null
            : fileVariantLabel(rec.file.name, version.name, uniqueTokens));
        row.versions.push({
          versionKey: version.key,
          versionName: version.name,
          group: version.group,
          file: rec.file,
          variantLabel: label,
        });
        // R6：视频版标记要看「文件本身是不是视频」，而不是看版本里有没有别的格式
        if (rec.file.kind === 'video') row.hasVideo = true;
      }
    }
  }

  const versionList = [...versions.values()].map((v) => {
    const formats = [...v.formats];
    // R5：一个版本内部，逐轨道优先使用 wav；只有 mp3 的版本照常使用 mp3
    const preferred = formats.includes('wav') ? 'wav'
      : formats.includes('mp3') ? 'mp3'
        : formats.includes('flac') ? 'flac'
          : formats.includes('video') ? 'video' : (formats[0] ?? 'unknown');
    return {
      key: v.key,
      name: v.name,
      group: v.group,
      formats,
      preferredFormat: preferred,
      isVideo: v.isVideo,
      fileCount: v.fileCount,
      bytes: v.bytes,
    };
  });

  /* R14：残留差分标记检测（文件名与文件夹版本标识不一致） */
  const conflicts = [];
  for (const version of versions.values()) {
    for (const list of version.files.values()) {
      for (const rec of list) {
      const rawBase = stripExt(rec.file.name);
      for (const m of rawBase.matchAll(/[（(]([^）)]*)[)）]/g)) {
        const inside = m[1];
        if (!inside) continue;
        let rest = inside;
        for (const token of uniqueTokens) {
          if (!token) continue;
          rest = rest.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
        }
        rest = rest.replace(/[\s、，,・_+\-]/g, '');
        if (!rest) continue;
        const related = uniqueTokens.find((t) => t.includes(rest) || rest.includes(t));
        if (related) {
          conflicts.push({
            type: 'filename-variant',
            file: relText(relOf(rootDir, rec.file.path)),
            versionFromFolder: version.name,
            leftover: rest,
            relatedToken: related,
            note: `文件名括号内残留「${rest}」与版本标记「${related}」相关，与文件夹版本标识「${version.name}」不一致，请人工确认`,
          });
        }
      }
      }
    }
  }

  if (taggedAlbum && releaseTitle) {
    const a = looseKey(taggedAlbum);
    const b = looseKey(releaseTitle);
    if (a && b && !a.includes(b) && !b.includes(a)) {
      conflicts.push({
        type: 'title',
        folderName: releaseTitle,
        tagValue: taggedAlbum,
        note: '文件夹名与内嵌标签的专辑名不一致（默认采用标签，仅提示）',
      });
    }
  }

  /* R10+：按相似度合并轨道行（自动合并 + 把握不足的进「待确认」） */
  const beforeMerge = trackRows.size;
  const mergeCandidates = mergeSimilarRows(trackRows, uniqueTokens, decisions ?? undefined);
  const mergedRows = beforeMerge - trackRows.size;

  /* 把冲突回填到轨道行，供界面标 ⚠ */
  const conflictFiles = new Set(conflicts.filter((c) => c.file).map((c) => c.file));
  for (const row of trackRows.values()) {
    const hit = row.versions.find((v) => conflictFiles.has(relText(relOf(rootDir, v.file.path))));
    if (hit) {
      row.conflict = true;
      row.conflictNote = conflicts.find((c) => c.file === relText(relOf(rootDir, hit.file.path)))?.note;
    }
  }

  const rows = [...trackRows.values()].sort((a, b) => {
    if (a.isBonus !== b.isBonus) return a.isBonus ? 1 : -1;
    return (a.trackNo ?? 9999) - (b.trackNo ?? 9999);
  });

  return {
    releaseRoot: rootDir,
    folderName: path.basename(rootDir),
    rjCode: locateRelease(rootDir)?.rjCode ?? null,
    nestedRjCodes: [...nestedRjCodes],
    hasBonus: versionList.some((v) => v.group === 'bonus') || rows.some((r) => r.isBonus),
    titleFromFolder: releaseTitle,
    titleFromTag: taggedAlbum,
    artistFromTag: pickTrackArtist(tagArtists) ?? albumArtistFromTag,
    albumArtistFromTag,
    tagArtists,
    versions: versionList.sort((a, b) => (a.group === b.group
      ? a.name.localeCompare(b.name, 'zh')
      : (a.group === 'main' ? -1 : 1))),
    tracks: rows.filter((r) => !r.isBonus),
    bonusTracks: rows.filter((r) => r.isBonus),
    ignored,
    conflicts,
    mergeCandidates,
    cover: pickCover(files),
    stats: {
      files: files.length,
      audio: files.filter((f) => f.kind === 'audio').length,
      video: files.filter((f) => f.kind === 'video').length,
      other: files.filter((f) => f.kind === 'other').length,
      /** 版本数：主集合里可用的完整渲染数（视频版不计入） */
      versionCount: versionList.filter((v) => v.group === 'main' && !v.isVideo).length,
      bonusVersionCount: versionList.filter((v) => v.group === 'bonus').length,
      /** 相似度合并掉的重复轨道行数 */
      mergedRows,
    },
  };
}
