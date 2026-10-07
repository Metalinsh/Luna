/**
 * 压缩包读取（P1：ZIP，只读）
 *
 * 设计要点（见 docs/压缩包支持设计.md §4、§5.1）：
 *   1. **只读中央目录**即可拿到完整清单，不解压任何音频数据；
 *   2. 文件名编码不信任 flags bit11：实测大量音声包的名称是 Shift-JIS 且未置位，
 *      因此按「UTF-8(fatal) → Shift-JIS → GB18030」打分挑选（§5.1.1）；
 *   3. 能力不足时**如实标注**（unsupported / encrypted），绝不静默跳过；
 *   4. 只依赖内置模块：node:zlib 解 deflate，TextDecoder 解文件名，零新增运行时依赖。
 *
 * 本模块为纯函数式工具，不触碰数据库，也不写任何文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';

/* ------------------------------------------------------------------ 常量 */

export const ZIP_EXT = '.zip';

/** P1 明确支持的压缩方法：仅 stored 与 deflate */
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** EOCD 最少 22 字节；注释最长 65535，因此最多回看 65557 字节 */
const EOCD_MAX_BACKSCAN = 65557;

const EOCD64_MIN = 56;
const CENTRAL_MIN = 46;
const LOCAL_MIN = 30;

/** 解压比上限：超过即判定为可疑（递归炸弹防护，$2.2 一并用于 P2） */
const MAX_COMPRESSION_RATIO = 500;
/** 无压缩信息时允许的最大解出体积（防御性上限，正常成员不会触及） */
const MAX_MEMBER_BYTES = 8 * 1024 * 1024 * 1024;

const AUDIO_EXT = new Set([
  '.mp3', '.flac', '.m4a', '.m4b', '.aac', '.ogg', '.oga', '.opus',
  '.wav', '.aiff', '.aif', '.aifc', '.wma', '.ape', '.wv', '.dsf', '.dff', '.mpc', '.tak',
]);
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.m4v', '.mov', '.avi']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

const utf8Fatal = new TextDecoder('utf-8', { fatal: true });
const utf8Loose = new TextDecoder('utf-8');
const sjis = new TextDecoder('shift_jis');
const gb18030 = new TextDecoder('gb18030');

/* ------------------------------------------------------------- 文件名解码 */

/** 编码名 → 解码器（整包统一解码时用） */
function decoderFor(encoding) {
  switch (encoding) {
    case 'shift_jis': return sjis;
    case 'gb18030': return gb18030;
    default: return utf8Loose;
  }
}

/**
 * 给一段解码结果打分，**分越低越好**。
 *
 * 这里的权重是实测逼出来的：Shift-JIS 与 GB18030 对大量 CJK 字节序列**都能成功解码**，
 * 只统计替换字符无法分辨。两项语言先验能把绝大多数条目分开：
 *   ① 半宽片假名/标点（U+FF61–U+FF9F）—— 日文文件名几乎不会用它，
 *      出现基本等于「拿 Shift-JIS 去解 GBK 假名字节」；
 *   ② 纯 CJK 汉字（≥5 字且一个假名都没有）—— 真实日文标题几乎必然带假名。
 * 两项都只是**先验**，不是硬规则；无法分辨的条目交给整包多数票（见 probeZip）。
 */
function scoreDecoded(text) {
  let bad = 0;
  let kana = 0;
  let cjk = 0;
  let halfWidth = 0;

  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 0xfffd) { bad += 100; continue; }                            // 替换字符：编码不成立
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) { bad += 50; continue; }
    if (c >= 0x7f && c <= 0x9f) { bad += 50; continue; }                   // C1 控制字符
    if (c >= 0xe000 && c <= 0xf8ff) { bad += 20; continue; }               // 私用区
    if (c >= 0x3041 && c <= 0x30ff) { kana += 1; continue; }               // 平假名 + 片假名
    if (c >= 0xff61 && c <= 0xff9f) { halfWidth += 1; continue; }          // 半宽片假名
    if (c >= 0x4e00 && c <= 0x9fff) cjk += 1;                              // CJK 汉字
  }

  if (halfWidth) bad += 6 * halfWidth;
  if (cjk >= 5 && kana === 0) bad += 8;
  return bad;
}

/**
 * 解出一个 ZIP 条目名。UTF-8 严格通过就一定是 UTF-8（多字节序列极难偶然成立）；
 * 否则在候选编码里按分数择优。
 *
 * @returns {{ text: string, encoding: string, score: number }}
 */
export function decodeEntryName(raw, utf8Flag = false) {
  if (utf8Flag) {
    return { text: utf8Loose.decode(raw), encoding: 'utf-8', score: 0 };
  }
  const candidates = [];
  try {
    const t = utf8Fatal.decode(raw);
    candidates.push({ text: t, encoding: 'utf-8', score: scoreDecoded(t) });
  } catch {
    /* 不是合法 UTF-8，跳过 */
  }
  const tSjis = sjis.decode(raw);
  candidates.push({ text: tSjis, encoding: 'shift_jis', score: scoreDecoded(tSjis) });
  const tGbk = gb18030.decode(raw);
  candidates.push({ text: tGbk, encoding: 'gb18030', score: scoreDecoded(tGbk) });

  candidates.sort((a, b) => a.score - b.score || a.encoding.localeCompare(b.encoding));
  return candidates[0];
}

/* --------------------------------------------------------------- 虚拟路径 */

/** 压缩包内的成员分隔符（与 ZIP 规范一致） */
export const MEMBER_SEP = '\u0000';

/**
 * 合成虚拟路径：`<压缩包绝对路径>\0<成员相对路径>`。
 *
 * 这样拼的理由（设计文档 §4.2）：asmr.mjs 是纯路径解析，
 * 把压缩包文件本身当成一层「虚拟目录」，就能让 locateRelease() 把
 * **压缩包本身识别为发行根**，从而复用整套音声三层模型。
 */
export function virtualPath(archivePath, memberPath) {
  const member = String(memberPath).replace(/\\/g, '/').replace(/^\/+/, '');
  return `${archivePath}${MEMBER_SEP}${member}`;
}

/** 拆解虚拟路径；非虚拟路径返回 null */
export function splitVirtualPath(p) {
  const s = String(p ?? '');
  const i = s.indexOf(MEMBER_SEP);
  if (i < 0) return null;
  return { archivePath: s.slice(0, i), memberPath: s.slice(i + 1) };
}

/** 该路径是否是压缩包虚拟路径 */
export function isVirtualPath(p) {
  return splitVirtualPath(p) !== null;
}

/** 判断扩展名是否是可尝试解析的压缩包（仅看名字，不看内容） */
export function isArchiveName(filePath) {
  return path.extname(String(filePath ?? '')).toLowerCase() === ZIP_EXT;
}

/**
 * 轻量签名探测：文件尾部存在 EOCD 才认为是 ZIP。
 * 用于避免把「恰好叫 .zip 的普通文件」当成压缩包处理。
 * 调用方若已解析过包，不必重复调用。
 */
export function looksLikeZip(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < 22) return false;
    const back = Math.min(size, EOCD_MAX_BACKSCAN);
    const buf = Buffer.alloc(back);
    fs.readSync(fd, buf, 0, back, size - back);
    for (let i = buf.length - 22; i >= 0; i -= 1) {
      if (buf.readUInt32LE(i) === SIG_EOCD) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
  }
}

/* ----------------------------------------------------------------- 条目类型 */

/** 按扩展名归类：audio / video / image / other / dir */
function kindOf(name) {
  if (name.endsWith('/')) return 'dir';
  const ext = path.extname(name).toLowerCase();
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (IMAGE_EXT.has(ext)) return 'image';
  return 'other';
}

/* --------------------------------------------------------------- 核心解析 */

/**
 * 打开一个 ZIP 并只读其中央目录。
 *
 * @param {string} filePath 压缩包绝对路径
 * @returns {Promise<{
 *   path: string, size: number, mtime: number, entryCount: number,
 *   entries: Array<object>, nameEncoding: string, encrypted: boolean,
 *   unsupported: boolean, zip64: boolean
 * }>}
 * @throws {Error} 不是合法 ZIP / 结构损坏（带 code 字段，便于调用方分类处理）
 */
export async function probeZip(filePath) {
  const st = await fs.promises.stat(filePath);
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const tailLen = Math.min(st.size, EOCD_MAX_BACKSCAN);
    if (st.size < 22) {
      throw archiveError('NOT_ZIP', '文件过小，不是有效的 ZIP');
    }
    const tailStart = st.size - tailLen;
    const tail = Buffer.alloc(tailLen);
    await handle.read(tail, 0, tailLen, tailStart);

    // 1) 从尾部倒序找 EOCD（跳过尾部注释）
    let eocdPos = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
      // 校验注释长度自洽，排除偶然出现的同值字节
      const commentLen = tail.readUInt16LE(i + 20);
      if (i + 22 + commentLen <= tail.length) { eocdPos = i; break; }
      if (eocdPos < 0) eocdPos = i;
    }
    if (eocdPos < 0) throw archiveError('NOT_ZIP', '未找到 ZIP 中央目录结尾记录（EOCD）');

    let entryCount = tail.readUInt16LE(eocdPos + 10);
    let cdSize = tail.readUInt32LE(eocdPos + 12);
    let cdOffset = tail.readUInt32LE(eocdPos + 16);
    let zip64 = false;

    // 2) ZIP64：借 EOCD64 定位器拿到真实的条目数与目录偏移
    const locatorRel = eocdPos - 20;
    if (locatorRel >= 0 && tail.readUInt32LE(locatorRel) === SIG_EOCD64_LOCATOR) {
      const eocd64Abs = Number(tail.readBigUInt64LE(locatorRel + 8));
      if (eocd64Abs >= 0 && eocd64Abs + EOCD64_MIN <= st.size) {
        const e64 = Buffer.alloc(EOCD64_MIN);
        await handle.read(e64, 0, EOCD64_MIN, eocd64Abs);
        if (e64.readUInt32LE(0) === SIG_EOCD64) {
          entryCount = Number(e64.readBigUInt64LE(32));
          cdSize = Number(e64.readBigUInt64LE(40));
          cdOffset = Number(e64.readBigUInt64LE(48));
          zip64 = true;
        }
      }
    }
    if (cdOffset === 0xffffffff || entryCount === 0xffff) {
      // 标记为 ZIP64 但没读到 EOCD64：条目数不可信，按目录区实际长度兜底
      zip64 = true;
    }
    if (!Number.isFinite(cdOffset) || cdOffset < 0 || cdSize < 0) {
      throw archiveError('DAMAGED', '中央目录偏移不合法');
    }

    // 3) 读中央目录
    const cdLen = Math.min(cdSize, Math.max(0, st.size - cdOffset));
    const cd = Buffer.alloc(cdLen);
    if (cdLen > 0) await handle.read(cd, 0, cdLen, cdOffset);

    const entries = [];
    let p = 0;
    while (p + CENTRAL_MIN <= cd.length && cd.readUInt32LE(p) === SIG_CENTRAL) {
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const dosTime = cd.readUInt16LE(p + 12);
      const dosDate = cd.readUInt16LE(p + 14);
      let crc32 = cd.readUInt32LE(p + 16);
      let packedSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);

      const rawName = cd.subarray(p + 46, p + 46 + nameLen);
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      const nameFlags = { utf8: (flags & 0x800) !== 0 };

      // ZIP64 扩展字段（0x0001）：按顺序填补被置为 0xffffffff 的字段
      if (size === 0xffffffff || packedSize === 0xffffffff || localOffset === 0xffffffff) {
        let q = 0;
        while (q + 4 <= extra.length) {
          const id = extra.readUInt16LE(q);
          const len = extra.readUInt16LE(q + 2);
          if (id === 0x0001) {
            const z = extra.subarray(q + 4, q + 4 + len);
            let zo = 0;
            if (size === 0xffffffff && zo + 8 <= z.length) { size = Number(z.readBigUInt64LE(zo)); zo += 8; }
            if (packedSize === 0xffffffff && zo + 8 <= z.length) { packedSize = Number(z.readBigUInt64LE(zo)); zo += 8; }
            if (localOffset === 0xffffffff && zo + 8 <= z.length) { localOffset = Number(z.readBigUInt64LE(zo)); zo += 8; }
            break;
          }
          q += 4 + len;
        }
      }

      const decoded = decodeEntryName(rawName, nameFlags.utf8);
      const encryptionFlag = (flags & 0x1) !== 0;
      // 目录条目：名称以 / 结尾，或外部属性标注为目录
      const externalAttrs = cd.readUInt32LE(p + 38);
      const isDir = decoded.text.endsWith('/') || ((externalAttrs >>> 16) & 0x10) === 0x10;

      entries.push({
        /* name 在读完中央目录后按「整包主编码」统一确定 */
        rawName,
        utf8Flag: nameFlags.utf8,
        decodedEncoding: decoded.encoding,
        /** 该条目是否由第一轮打分自行决胜（多候选并列时为 false） */
        decisive: decoded.score === 0,
        kind: isDir ? 'dir' : kindOf(decoded.text),
        size: isDir ? 0 : size,
        packedSize,
        method,
        crc32: isDir ? 0 : crc32,
        mtime: dosToMs(dosDate, dosTime),
        localOffset,
        encrypted: encryptionFlag,
        nameEncoding: decoded.encoding,
        /** 能否在 P1 解出：加密或压缩方法不支持时为 false */
        readable: !isDir && !encryptionFlag && (method === METHOD_STORED || method === METHOD_DEFLATE),
      });

      p += CENTRAL_MIN + nameLen + extraLen + commentLen;
    }

    if (!entries.length && entryCount > 0) {
      throw archiveError('DAMAGED', '中央目录为空或已损坏');
    }

    /* ---------------------------------------------------------------
     * 文件名编码的最终裁决
     *
     * 现实约束：Shift-JIS 与 GB18030 对大量 CJK 字节序列**都能成功解码**
     * （同一份字节可以同时是合法的日文与合法中文），逐条打分必然在
     * 「纯汉字」条目上平手。因此分两步：
     *   ① 第一轮逐条决胜 → 统计票数，找出主编码；
     *   ② 用主编码**重新解一遍无法自行决胜的条目**，保证整包风格一致。
     * 真实包通常整包同编码，这一步能把「同包里一半中文一半日文」消掉。
     * --------------------------------------------------------------- */
    const votes = new Map();
    let utf8Flagged = 0;
    let decisive = 0;
    for (const e of entries) {
      if (e.utf8Flag) { utf8Flagged += 1; continue; }
      votes.set(e.decodedEncoding, (votes.get(e.decodedEncoding) ?? 0) + 1);
      if (e.decisive) decisive += 1;
    }
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const dominant = ranked.length ? ranked[0][0] : 'utf-8';
    const dominantDecoder = decoderFor(dominant);

    let overridden = 0;
    for (const e of entries) {
      if (!e.utf8Flag && e.decodedEncoding !== dominant) overridden += 1;
      const useUtf8 = e.utf8Flag || dominant === 'utf-8';
      e.name = useUtf8
        ? e.rawName.toString('utf8').replace(/\\/g, '/')
        : dominantDecoder.decode(e.rawName).replace(/\\/g, '/');
      if (!useUtf8) e.nameEncoding = dominant;
      e.kind = e.kind === 'dir' ? 'dir' : kindOf(e.name);
      delete e.rawName;
      delete e.utf8Flag;
      delete e.decisive;
    }

    return {
      path: filePath,
      size: st.size,
      mtime: Math.round(st.mtimeMs),
      entryCount: entries.length,
      entries,
      /** 整包采用的主编码（出现多种编码时为 mixed） */
      nameEncoding: ranked.length > 1 ? 'mixed' : dominant,
      dominantEncoding: dominant,
      nameEncodingVotes: Object.fromEntries(ranked),
      utf8Flagged,
      /** 第一轮就自行决胜的条目数（用于判断裁决可信度） */
      decisiveEntries: decisive,
      /** 被主编码改写解法的条目数 */
      overriddenEntries: overridden,
      encrypted: entries.some((e) => e.encrypted),
      unsupported: entries.some((e) => !e.readable && !e.encrypted && e.kind !== 'dir'),
      zip64,
    };
  } finally {
    await handle.close();
  }
}

function archiveError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** DOS 日期时间 → 毫秒时间戳（无效值返回 null） */
function dosToMs(date, time) {
  if (!date) return null;
  const year = ((date >>> 9) & 0x7f) + 1980;
  const month = (date >>> 5) & 0x0f;
  const day = date & 0x1f;
  const hour = (time >>> 11) & 0x1f;
  const minute = (time >>> 5) & 0x3f;
  const second = (time & 0x1f) * 2;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

/* ----------------------------------------------------------------- 取成员 */

/** 在已解析的 entries 里找成员（按归一化后的名称匹配） */
export function findEntry(entries, memberPath) {
  const want = String(memberPath).replace(/\\/g, '/').replace(/^\/+/, '');
  return entries.find((e) => e.name === want) ?? null;
}

/**
 * 读出已完成中央目录解析的成员的**解密后数据**。
 *
 * @param {string} filePath 压缩包路径
 * @param {object} entry probeZip() 返回的条目对象
 * @returns {Promise<Buffer>}
 */
export async function readEntryData(filePath, entry) {
  if (!entry) throw archiveError('NO_ENTRY', '条目不存在');
  if (entry.kind === 'dir') return Buffer.alloc(0);
  if (entry.encrypted) throw archiveError('ENCRYPTED', '条目已加密，P1 暂不支持');
  if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
    throw archiveError('UNSUPPORTED_METHOD', `暂不支持的压缩方法（method=${entry.method}）`);
  }
  if (entry.size > MAX_MEMBER_BYTES) {
    throw archiveError('TOO_LARGE', `成员体积超出安全上限（${entry.size} 字节）`);
  }
  guardCompressionRatio(entry);

  const handle = await fs.promises.open(filePath, 'r');
  try {
    // 本地头长度可能与中央目录不同（含额外字段），必须按本地头重新定位数据起点
    const head = Buffer.alloc(LOCAL_MIN);
    await handle.read(head, 0, LOCAL_MIN, entry.localOffset);
    if (head.readUInt32LE(0) !== SIG_LOCAL) {
      throw archiveError('DAMAGED', `本地文件头签名不匹配：${entry.name}`);
    }
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const dataStart = entry.localOffset + LOCAL_MIN + nameLen + extraLen;

    const packed = Buffer.alloc(entry.packedSize);
    if (entry.packedSize > 0) await handle.read(packed, 0, entry.packedSize, dataStart);

    if (entry.method === METHOD_STORED) {
      if (packed.length !== entry.size) {
        throw archiveError('DAMAGED', `存储型成员长度不符：${entry.name}`);
      }
      return packed;
    }
    const out = zlib.inflateRawSync(packed);
    if (out.length !== entry.size) {
      throw archiveError('DAMAGED', `解压后长度不符：${entry.name}（得到 ${out.length}，期望 ${entry.size}）`);
    }
    return out;
  } finally {
    await handle.close();
  }
}

/**
 * 流式读出一个成员的**解密后数据**（大文件用它，避免整块进内存）。
 * @returns {Promise<{ stream: NodeJS.ReadableStream, size: number, entry: object }>}
 */
export async function openEntryStream(filePath, entry) {
  if (!entry) throw archiveError('NO_ENTRY', '条目不存在');
  if (entry.kind === 'dir') throw archiveError('IS_DIR', '条目是目录');
  if (entry.encrypted) throw archiveError('ENCRYPTED', '条目已加密，P1 暂不支持');
  if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
    throw archiveError('UNSUPPORTED_METHOD', `暂不支持的压缩方法（method=${entry.method}）`);
  }
  guardCompressionRatio(entry);

  const handle = await fs.promises.open(filePath, 'r');
  try {
    const head = Buffer.alloc(LOCAL_MIN);
    await handle.read(head, 0, LOCAL_MIN, entry.localOffset);
    if (head.readUInt32LE(0) !== SIG_LOCAL) {
      throw archiveError('DAMAGED', `本地文件头签名不匹配：${entry.name}`);
    }
    const dataStart = entry.localOffset + LOCAL_MIN + head.readUInt16LE(26) + head.readUInt16LE(28);

    let stream;
    if (entry.packedSize === 0) {
      stream = ReadableFromBuffer(Buffer.alloc(0));
    } else {
      stream = fs.createReadStream(filePath, {
        start: dataStart,
        end: dataStart + entry.packedSize - 1,
        autoClose: true,
      });
    }
    if (entry.method === METHOD_DEFLATE) {
      const inflate = zlib.createInflateRaw();
      stream.on('error', (err) => inflate.destroy(err));
      stream = stream.pipe(inflate);
    }
    return { stream, size: entry.size, entry };
  } finally {
    await handle.close();
  }
}

/** 便捷封装：按成员路径取值（小文件用） */
export async function readMember(filePath, memberPath) {
  const info = await probeZip(filePath);
  const entry = findEntry(info.entries, memberPath);
  if (!entry) throw archiveError('NO_ENTRY', `包内不存在该成员：${memberPath}`);
  const data = await readEntryData(filePath, entry);
  return { data, entry, info };
}

/* ------------------------------------------------------------------- 工具 */

function guardCompressionRatio(entry) {
  if (!entry.packedSize) return;
  const ratio = entry.size / entry.packedSize;
  if (ratio > MAX_COMPRESSION_RATIO) {
    throw archiveError('SUSPICIOUS_RATIO',
      `解压比异常（${Math.round(ratio)}:1），已拒绝以防压缩炸弹：${entry.name}`);
  }
}

/** 小工具：把 Buffer 包成可读流（避免为 0 字节成员额外开文件句柄） */
function ReadableFromBuffer(buf) {
  return Readable.from([buf]);
}

/* ----------------------------------------------------------------- 汇总信息 */

/** 把一次 probeZip 的结果汇总为入库用元数据 */
export function summarizeArchive(info) {
  const files = info.entries.filter((e) => e.kind !== 'dir');
  const count = (kind) => files.filter((e) => e.kind === kind).length;
  return {
    format: 'zip',
    entryCount: info.entries.filter((e) => e.kind !== 'dir').length,
    audioCount: count('audio'),
    imageCount: count('image'),
    videoCount: count('video'),
    packedBytes: files.reduce((n, e) => n + (e.packedSize || 0), 0),
    unpackedBytes: files.reduce((n, e) => n + (e.size || 0), 0),
    encrypted: info.encrypted,
    unsupported: info.unsupported,
    nameEncoding: info.nameEncoding,
    zip64: info.zip64,
    mtime: info.mtime,
    size: info.size,
  };
}
