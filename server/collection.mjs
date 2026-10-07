/**
 * 压缩包按需解码与缓存（P2）。
 *
 * 设计要点（见 docs/压缩包支持设计.md §4.3、§7）：
 *   - 缓存目录是**纯派生数据**，整个删掉可以随时重建；
 *   - 因此清空缓存不做备份、不做撤销，但**必须严格校验目录身份**，
 *     避免用户配错目录后被我们清掉无关文件；
 *   - 缓存上限是「本产品第一个会把磁盘吃满的失败模式」，
 *     所以超限必须**明确拒绝并告知**，不能静默截断或崩溃；
 *   - 解码**流式落盘**（不整块进内存）：音声整轨 wav 可能上 GB；
 *   - 写入用「临时文件 + 原子改名」：半截文件绝不能被当成完整缓存。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

import { readConfig, resolveCacheDir, CACHE_DIR_NAME, DATA_DIR } from './config.mjs';
import { probeZip, openEntryStream, findEntry } from './zip-reader.mjs';
import { pathLayers } from './asmr.mjs';
import * as store from './db.mjs';

/** 缓存目录内用于标识「这个目录确实是 Luna 的缓存」的标记文件 */
export const CACHE_MARKER = '.luna-cache';

/**
 * 确保缓存目录存在，并打上身份标记。
 * 注意：**只在真正需要缓存时才调用**，避免用户改完设置就凭空多出空目录。
 */
export async function ensureCacheDir(dir = resolveCacheDir()) {
  await fsp.mkdir(dir, { recursive: true });
  const marker = path.join(dir, CACHE_MARKER);
  try {
    if (!fs.existsSync(marker)) {
      await fsp.writeFile(marker, JSON.stringify({
        app: 'luna', kind: 'archive-cache', createdAt: Date.now(),
      }, null, 2), 'utf8');
    }
  } catch { /* 标记写不进去不阻塞使用 */ }
  return dir;
}

/** 目录是否可写（不存在则尝试创建） */
export async function ensureWritable(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.access(dir, fs.constants.W_OK);
    return { ok: true, dir };
  } catch (err) {
    return { ok: false, dir, error: err.code ?? err.message };
  }
}

/** 递归统计目录：文件数 + 总字节 */
async function walkStats(dir) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.isFile()) continue;
      try { bytes += (await fsp.stat(full)).size; files += 1; } catch { /* 忽略 */ }
    }
  }
  return { files, bytes };
}

/**
 * 缓存当前状态：占用、上限、是否可用、目录身份。
 * 供设置界面显示，也供写缓存前做容量判断。
 */
export async function cacheStatus() {
  const cfg = readConfig();
  const dir = resolveCacheDir(cfg);
  const maxBytes = cfg.archive.maxBytes;
  // 以**磁盘实测**为准（登记表可能因手工删文件而过期），同时给出登记数便于排查
  const registered = store.cacheEntryStats();
  const out = {
    dir,
    maxBytes,
    exists: false,
    isCacheDir: false,
    files: 0,
    bytes: 0,
    registered,
    freeBytes: null,
    writable: null,
    sameVolumeAsData: null,
  };

  try {
    const st = await fsp.stat(dir);
    out.exists = st.isDirectory();
  } catch { /* 不存在 */ }

  if (out.exists) {
    out.isCacheDir = fs.existsSync(path.join(dir, CACHE_MARKER));
    const s = await walkStats(dir);
    out.files = s.files;
    out.bytes = s.bytes;
    const w = await ensureWritable(dir);
    out.writable = w.ok;
    if (!w.ok) out.error = w.error;
  } else {
    // 尚不存在：检查父目录能否创建
    const w = await ensureWritable(dir);
    out.writable = w.ok;
    if (!w.ok) out.error = w.error;
    try { await fsp.rmdir(dir).catch(() => {}); } catch { /* 忽略 */ }
  }

  // 空闲空间：用 statfs（Node 18.15+ 提供）
  try {
    const probe = out.exists ? dir : path.dirname(dir);
    const sfs = await fsp.statfs(probe);
    out.freeBytes = Number(sfs.bavail) * Number(sfs.bsize);
  } catch { /* 平台不支持则留 null */ }

  // 是否与数据目录（library.db 所在）同卷：跨卷时缓存内容要跨盘拷贝，体验会明显变差
  try {
    const probe = out.exists ? dir : path.dirname(dir);
    const a = (await fsp.stat(probe)).dev;
    const b = (await fsp.stat(DATA_DIR)).dev;
    out.sameVolumeAsData = a === b;
  } catch { /* 忽略 */ }

  out.usageRatio = maxBytes > 0 ? out.bytes / maxBytes : 0;
  return out;
}

/**
 * 清空缓存（只删内容，保留目录与身份标记）。
 *
 * 安全约束：目录名必须是 luna_cache，或目录内存在标记文件 —— 两者都不满足时
 * **拒绝执行**，避免用户把缓存目录配到了某个重要文件夹上被一键清空。
 */
export async function clearCache({ force = false } = {}) {
  const cfg = readConfig();
  const dir = resolveCacheDir(cfg);

  if (!fs.existsSync(dir)) return { ok: true, cleared: 0, bytes: 0, dir, note: '目录不存在' };

  const base = path.basename(dir).toLowerCase();
  const hasMarker = fs.existsSync(path.join(dir, CACHE_MARKER));
  const looksLikeCache = base === CACHE_DIR_NAME.toLowerCase() || hasMarker;

  if (!looksLikeCache && !force) {
    return {
      ok: false,
      dir,
      error: `拒绝清空：${dir} 既不是 ${CACHE_DIR_NAME} 目录，也没有缓存标记文件。`
        + '如果确认它就是缓存目录，请先手动清空或在设置里改回默认目录。',
    };
  }

  const before = await walkStats(dir);
  let failed = 0;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (err) {
    return { ok: false, dir, error: `无法读取目录：${err.code ?? err.message}` };
  }
  for (const e of entries) {
    // 保留身份标记，目录身份不因清空而丢失
    if (e.isFile() && e.name === CACHE_MARKER) continue;
    try {
      await fsp.rm(path.join(dir, e.name), { recursive: true, force: true });
    } catch { failed += 1; }
  }

  const after = await walkStats(dir);
  // 登记表必须一起清：否则 LRU 会拿着已不存在的记录，缓存状态也会虚高
  const forgotten = forgetAllCacheEntries();
  return {
    ok: failed === 0,
    dir,
    cleared: before.files - after.files,
    bytes: before.bytes - after.bytes,
    remaining: after.bytes,
    failed,
    forgotten,
    note: failed ? `${failed} 个条目被占用或权限不足，未能删除` : undefined,
  };
}

/**
 * 人类可读体积（供容量判定与界面提示复用）。
 * 必须定义在 canCacheMember 之前被调用到 —— 函数声明会提升，这里保持顶层声明。
 */
export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
  return `${x >= 100 ? x.toFixed(0) : x.toFixed(1)} ${units[i]}`;
}

/**
 * 判断「为了播放某个成员，需要占用多少缓存」，并对照上限给出结论。
 *
 * 用户要求：**若需要读取的压缩包已超过缓存容量大小，放弃读取并提示用户文件过大。**
 * 这里以「单个成员解压后体积」为判据 —— 播放只需要该成员，不是整个包。
 *
 * @param {object} member 形如 { name, size, packedSize }
 * @returns {{ allowed: boolean, needBytes: number, maxBytes: number, freeBytes: number|null,
 *             reason?: string, code?: string }}
 */
export async function canCacheMember(member, { cfg = readConfig(), status = null } = {}) {
  const st = status ?? await cacheStatus();
  // deflate 成员解压后可能比压缩体积大；用解压后体积作为需要占用的空间
  const needBytes = Number(member?.size ?? 0) || Number(member?.packedSize ?? 0) || 0;
  const maxBytes = st.maxBytes;

  if (needBytes > maxBytes) {
    return {
      allowed: false,
      needBytes,
      maxBytes,
      freeBytes: st.freeBytes,
      code: 'MEMBER_TOO_LARGE',
      reason: `该文件解压后需要 ${fmtBytes(needBytes)}，已超过缓存上限 ${fmtBytes(maxBytes)}。`
        + '请在设置中调大缓存上限，或改用 P3 的「落盘」功能。',
    };
  }

  // 预留 256 MiB 余量：缓存写满整块盘会连带影响数据库写入
  const reserve = 256 * 1024 ** 2;
  if (st.freeBytes != null && needBytes + reserve > st.freeBytes) {
    return {
      allowed: false,
      needBytes,
      maxBytes,
      freeBytes: st.freeBytes,
      code: 'DISK_FULL',
      reason: `磁盘剩余空间不足：需要约 ${fmtBytes(needBytes + reserve)}，`
        + `当前仅剩 ${fmtBytes(st.freeBytes)}。请清理磁盘或在设置中更换缓存目录。`,
    };
  }

  return { allowed: true, needBytes, maxBytes, freeBytes: st.freeBytes };
}

/* ======================================================= 按需解码（P2 核心） */

/** 正在解码的成员：key = `${archiveId}\0${memberPath}` → Promise，避免同一成员重复解码 */
const inflight = new Map();

/** 缓存文件的稳定命名：内容寻址（包 id + 包 mtime + 成员路径），同名成员不会互相覆盖 */
export function cacheFileNameFor(archive, memberPath) {
  const ext = path.extname(memberPath).toLowerCase() || '.bin';
  const digest = crypto.createHash('sha1')
    .update(`${archive?.id ?? ''}\u0000${archive?.file_mtime ?? ''}\u0000${memberPath}`)
    .digest('hex');
  return `${digest}${ext}`;
}

/**
 * 按缓存上限回收：按 last_used_at 从旧到新删，直到降到上限的 90%。
 * **正在使用的成员由调用方通过 protect 集合排除**（当前播放的文件不能被删）。
 */
export async function evictCache({ maxBytes = null, protect = new Set() } = {}) {
  const cfg = readConfig();
  const limit = maxBytes ?? cfg.archive.maxBytes;
  const entries = store.listCacheEntries();
  let total = entries.reduce((n, e) => n + (Number(e.bytes) || 0), 0);
  if (total <= limit) return { removed: 0, freed: 0, total };

  // 回收到 90%，避免每次写入都触发一次回收
  const target = Math.floor(limit * 0.9);
  let removed = 0;
  let freed = 0;
  for (const e of entries) {
    if (total <= target) break;
    if (protect.has(e.file_path) || protect.has(`${e.archive_id}\u0000${e.member_path}`)) continue;
    try {
      await fsp.rm(e.file_path, { force: true });
    } catch { /* 文件已不在就算了 */ }
    store.deleteCacheEntry(e.archive_id, e.member_path);
    total -= Number(e.bytes) || 0;
    freed += Number(e.bytes) || 0;
    removed += 1;
  }
  return { removed, freed, total };
}

/**
 * 确保某个压缩包成员已解码到缓存，返回它的本地文件路径。
 *
 * @param {object} track 形如 { archive_id, member_path, source_kind, materialized_state }
 * @returns {Promise<{ ok: true, file: string, bytes: number, cached: boolean }
 *                  | { ok: false, code: string, reason: string }>}
 */
export async function ensureMemberCached(track, { protect = new Set() } = {}) {
  if (!track?.archive_id || !track?.member_path) {
    return { ok: false, code: 'NOT_ARCHIVE_MEMBER', reason: '该曲目不是压缩包成员' };
  }
  const archive = store.getArchiveById(track.archive_id);
  if (!archive) return { ok: false, code: 'ARCHIVE_MISSING', reason: '压缩包登记不存在，请重新扫描' };

  const cfg = readConfig();
  const dir = resolveCacheDir(cfg);
  const key = `${archive.id}\u0000${track.member_path}`;

  // 已有缓存且文件还在 → 直接用
  const existing = store.getCacheEntry(archive.id, track.member_path);
  if (existing) {
    try {
      const st = await fsp.stat(existing.file_path);
      if (st.isFile() && st.size > 0) {
        store.touchCacheEntry(archive.id, track.member_path);
        return { ok: true, file: existing.file_path, bytes: st.size, cached: true };
      }
    } catch { /* 缓存文件不在了，下面重新解码 */ }
    store.deleteCacheEntry(archive.id, track.member_path);
  }

  // 同一成员的并发请求合并到同一次解码
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    // 源包不可达（网络盘/移动硬盘拔掉）：给出明确原因，而不是让它抛 ENOENT
    try {
      await fsp.access(archive.path, fs.constants.R_OK);
    } catch {
      return { ok: false, code: 'ARCHIVE_UNREACHABLE', reason: `源压缩包不可访问：${archive.path}` };
    }

    const info = await probeZip(archive.path);
    const entry = findEntry(info.entries, track.member_path);
    if (!entry) {
      return { ok: false, code: 'MEMBER_MISSING', reason: `包内已找不到该成员：${track.member_path}` };
    }
    if (entry.encrypted) return { ok: false, code: 'ENCRYPTED', reason: '该成员已加密，暂不支持' };
    if (!entry.readable) return { ok: false, code: 'UNSUPPORTED_METHOD', reason: '该成员的压缩方式暂不支持' };

    // 容量判断：单个成员超过上限，或磁盘放不下 → 放弃读取并告知
    const verdict = await canCacheMember(entry, { cfg });
    if (!verdict.allowed) return { ok: false, code: verdict.code, reason: verdict.reason };

    const writable = await ensureWritable(dir);
    if (!writable.ok) {
      return { ok: false, code: 'CACHE_DIR_UNWRITABLE', reason: `缓存目录不可写：${dir}（${writable.error}）` };
    }
    await ensureCacheDir(dir);

    const finalPath = path.join(dir, cacheFileNameFor(archive, track.member_path));
    // 先回收出空间，再写
    await evictCache({ protect });

    const tmpPath = `${finalPath}.lam-tmp-${process.pid}-${Date.now()}`;
    let written = 0;
    try {
      const { stream } = await openEntryStream(archive.path, entry);
      const out = fs.createWriteStream(tmpPath);
      stream.on('data', (c) => { written += c.length; });
      await pipeline(stream, out);
      if (entry.size && written !== entry.size) {
        throw new Error(`解压长度不符（得到 ${written}，期望 ${entry.size}）`);
      }
      await fsp.rename(tmpPath, finalPath);   // 原子就位：不会出现半截缓存
    } catch (err) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      return { ok: false, code: 'DECODE_FAILED', reason: `解码失败：${err.message}` };
    }

    store.upsertCacheEntry({
      archiveId: archive.id,
      memberPath: track.member_path,
      trackId: track.id ?? null,
      filePath: finalPath,
      bytes: written,
    });
    return { ok: true, file: finalPath, bytes: written, cached: false };
  })();

  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

/**
 * 解析「某个曲目应该从哪个本地文件播放」。
 * 普通曲目直接返回原路径；压缩包成员先确保已缓存，返回缓存文件路径。
 *
 * @returns {Promise<{ ok: true, file: string, fromCache: boolean, bytes: number }
 *                  | { ok: false, code: string, reason: string }>}
 */
export async function resolvePlayableFile(track, opts = {}) {
  if (track?.source_kind !== 'archive_member') {
    return { ok: true, file: track.path, fromCache: false, bytes: track.size ?? 0 };
  }
  // 已落盘（P3）的成员直接用真实路径
  if (track.materialized_state === 'ready' && track.path && !String(track.path).includes('\u0000')) {
    return { ok: true, file: track.path, fromCache: false, bytes: track.size ?? 0 };
  }
  const r = await ensureMemberCached(track, opts);
  if (!r.ok) return r;
  return { ok: true, file: r.file, fromCache: true, bytes: r.bytes };
}

/** 清空缓存时同时清掉登记（否则 LRU 会拿着失效记录） */
export function forgetAllCacheEntries() {
  const n = store.listCacheEntries().length;
  store.db.prepare('DELETE FROM cache_entries').run();
  return n;
}

