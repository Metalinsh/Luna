/**
 * 写操作安全框架（设计文档 5.3）—— V2.2 的核心。
 *
 * 五道关口：预览 → 备份 → 原子替换 → 写后校验 → 可撤销
 * 每个文件的关键顺序（保证磁盘上任何时刻都有一份完整可用副本）：
 *
 *   ① copy 原文件 → 同目录 .lam-tmp-*（原文件不动）
 *   ② writer 就地写标签到临时文件
 *   ③ music-metadata 重新解析临时文件校验字段
 *   ④ rename 原文件 → 备份目录（瞬时、零拷贝，同时成为撤销依据）
 *   ⑤ rename 临时文件 → 原路径（瞬时替换）
 *   ⑥ 重新解析原文件 → 同步索引
 *
 * 同卷 rename 是零拷贝的，所以备份不产生额外 I/O（1TB 大文件场景的关键）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { parseFile } from 'music-metadata';

import {
  UNDO_DIR, UNDO_DIR_NAME, ensureDirs,
} from './config.mjs';
import { db, getTrack, getLibrary, upsertTrack, resolveAlbumForTrack, findTrackByPath, listAlbumTracks, recomputeAlbumFields } from './db.mjs';
import { canWrite, writeTags } from './writers.mjs';

const now = () => Date.now();
const TEMP_PREFIX = '.lam-tmp-';

/**
 * 同卷内 rename 是瞬时零拷贝；跨卷（EXDEV）时降级为「复制 + 删除」。
 * 备份目录默认与源文件同卷，所以正常情况下不会走到复制分支。
 */
async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
    return 'renamed';
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(from, to);
    await fsp.rm(from, { force: true });
    return 'copied';
  }
}

/* --------------------------------------------------------------- 写锁 */

let currentJobId = null;
const waiters = [];

export function isWriting() {
  return currentJobId !== null;
}

export function currentWriteJobId() {
  return currentJobId;
}

/**
 * 一条曲目能否写回媒体文件。
 *
 * 压缩包内成员是**只读虚拟路径**（`zip\u0001member`），不能当普通文件复制/写入；
 * 因此即使扩展名受支持，也必须排除。磁盘上的普通文件才交给 writers 处理。
 */
export function isWritableTrack(track) {
  if (!track) return false;
  if (track.source_kind === 'archive_member' || track.archive_id != null) return false;
  return canWrite(track.ext);
}

/* --------------------------------------------------------------- 任务表 */

export function createJob({ type, items, backupDir, payload = {} }) {
  const info = db.prepare(`
    INSERT INTO write_jobs (type, status, payload_json, total, backup_dir, created_at)
    VALUES (?, 'pending', ?, ?, ?, ?)
  `).run(type, JSON.stringify(payload), items.length, backupDir ?? null, now());
  const jobId = Number(info.lastInsertRowid);

  const insertItem = db.prepare(`
    INSERT INTO write_job_items (job_id, track_id, path, status) VALUES (?, ?, ?, 'pending')
  `);
  for (const item of items) insertItem.run(jobId, item.trackId ?? null, item.path);
  return jobId;
}

export function getJob(jobId) {
  const job = db.prepare('SELECT * FROM write_jobs WHERE id = ?').get(Number(jobId));
  if (!job) return null;
  return {
    ...job,
    payload: job.payload_json ? JSON.parse(job.payload_json) : null,
    payload_json: undefined,
    items: db.prepare('SELECT * FROM write_job_items WHERE job_id = ? ORDER BY id').all(job.id),
  };
}

export function listJobs({ limit = 20 } = {}) {
  return db.prepare('SELECT * FROM write_jobs ORDER BY id DESC LIMIT ?').all(Number(limit))
    .map((job) => ({ ...job, payload_json: undefined }));
}

export function markInterruptedJobs() {
  const stale = db.prepare("SELECT id FROM write_jobs WHERE status IN ('running','verifying')").all();
  for (const row of stale) {
    db.prepare("UPDATE write_jobs SET status = 'interrupted', finished_at = ? WHERE id = ?")
      .run(now(), row.id);
  }
  return stale.map((r) => r.id);
}

/* ------------------------------------------------------- 校验与字段映射 */

const READBACK = {
  title: (meta) => meta.common.title ?? null,
  album: (meta) => meta.common.album ?? null,
  albumArtist: (meta) => meta.common.albumartist ?? null,
  artists: (meta) => meta.common.artist ?? null,
  trackNo: (meta) => meta.common.track?.no ?? null,
  discNo: (meta) => meta.common.disk?.no ?? null,
  year: (meta) => meta.common.year ?? null,
  genres: (meta) => (meta.common.genre ?? []).join('\u0000'),
  comment: (meta) => {
    const list = meta.common.comment ?? [];
    return list.map((c) => (typeof c === 'string' ? c : c.text)).join('\u0000');
  },
  picture: (meta) => (meta.common.picture?.length ?? 0) > 0,
};

/** 期望值 → 归一化后的比较值 */
function expectedValue(field, patch) {
  const value = patch[field];
  switch (field) {
    case 'genres': return (value ?? []).filter(Boolean).join('\u0000');
    case 'comment': return value ?? null;
    case 'picture': return Boolean(value?.data?.length);
    case 'artists': return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
    case 'trackNo': case 'discNo': case 'year': {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    default: return value ?? null;
  }
}

/** 用与读取完全相同的解析器校验写入结果 */
export async function verifyWrittenTags(filePath, patch) {
  const meta = await parseFile(filePath, { duration: false, skipCovers: false });
  const mismatches = [];
  for (const [field, read] of Object.entries(READBACK)) {
    if (!(field in patch)) continue;
    const actual = read(meta);
    const expected = expectedValue(field, patch);
    const same = typeof expected === 'boolean' ? actual === expected
      : String(actual ?? '') === String(expected ?? '');
    if (!same) mismatches.push({ field, expected, actual });
  }
  return { ok: mismatches.length === 0, mismatches };
}

/* ------------------------------------------------------------ 备份目录 */

/** 默认把备份放在音乐库根目录下（与源文件同卷 → rename 零拷贝） */
function resolveBackupDir(track) {
  const lib = track.library_id ? getLibrary(track.library_id) : null;
  if (lib?.path && fs.existsSync(lib.path)) {
    return path.join(lib.path, UNDO_DIR_NAME);
  }
  ensureDirs();
  return UNDO_DIR;
}

/* -------------------------------------------------------------- 单文件执行 */

async function ensureDiskSpace(dir, size) {
  try {
    const stat = fs.statfsSync(dir);
    const free = Number(stat.bavail) * Number(stat.bsize);
    return free >= size * 2.2;
  } catch {
    return true; // 取不到就放行，后续写入失败会正常报错
  }
}

async function canOpenExclusive(filePath) {
  try {
    const handle = await fsp.open(filePath, 'r+');
    await handle.close();
    return true;
  } catch (err) {
    return err.code !== 'EBUSY' && err.code !== 'EPERM';
  }
}

/**
 * 处理单个文件。返回 { status, error?, steps? }
 * status: done | skipped | failed
 */
export async function processFile({
  jobId, seq, track, patch, writer = writeTags, snapshot = null, keepBackup = true,
}) {
  const filePath = track.path;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const tempPath = path.join(dir, `${TEMP_PREFIX}${jobId}-${seq}${ext}`);
  const backupRoot = resolveBackupDir(track);
  const backupDir = path.join(backupRoot, String(jobId));
  const backupPath = path.join(backupDir, `${seq}${ext}`);

  const cleanupTemp = async () => {
    try { await fsp.rm(tempPath, { force: true }); } catch { /* 忽略 */ }
  };

  try {
    // ① 写前检查
    // 压缩包成员是只读虚拟路径，不能按磁盘文件 stat / copy / rename。
    if (track.source_kind === 'archive_member' || track.archive_id != null) {
      return { status: 'skipped', error: '压缩包内文件只读' };
    }
    const stat = await fsp.stat(filePath);
    if (!canWrite(ext)) return { status: 'skipped', error: `格式不支持写回（${ext}）` };
    if (!(await canOpenExclusive(filePath))) return { status: 'skipped', error: '文件正被其他程序占用' };
    if (!(await ensureDiskSpace(dir, stat.size))) return { status: 'skipped', error: '磁盘剩余空间不足' };

    // ② 乐观锁：编辑期间文件被外部修改则拒绝写入
    if (snapshot && (snapshot.size !== stat.size || snapshot.mtime !== Math.round(stat.mtimeMs))) {
      return { status: 'skipped', error: '文件在编辑期间被外部修改，请重新加载后再试' };
    }

    // ③ 工作副本
    await fsp.copyFile(filePath, tempPath);

    // ④ 写入
    const applied = writer(tempPath, patch);

    // ⑤ 校验
    const verify = await verifyWrittenTags(tempPath, patch);
    if (!verify.ok) {
      await cleanupTemp();
      const detail = verify.mismatches
        .map((m) => `${m.field}: 期望 ${m.expected} 实际 ${m.actual}`).join('；');
      return { status: 'failed', error: `写入后校验不一致（${detail}）` };
    }

    // ⑥ 就位备份：原文件改名到备份目录（瞬时、零拷贝；跨卷时自动降级为复制）
    await fsp.mkdir(backupDir, { recursive: true });
    await moveFile(filePath, backupPath);

    // ⑦ 原子替换
    try {
      await moveFile(tempPath, filePath);
    } catch (err) {
      // 替换失败 → 立即把备份改回原名
      try { await moveFile(backupPath, filePath); } catch { /* 尽力而为 */ }
      return { status: 'failed', error: `原子替换失败：${err.code ?? err.message}` };
    }

    if (!keepBackup) await fsp.rm(backupPath, { force: true });

    return {
      status: 'done',
      applied,
      backupPath: keepBackup ? backupPath : null,
      steps: { temp: tempPath, backup: backupPath },
    };
  } catch (err) {
    await cleanupTemp();
    return { status: 'failed', error: `${err.code ?? err.name}: ${String(err.message ?? err).slice(0, 160)}` };
  }
}

/**
 * 处理「非音频文件」的写操作（例如把封面写成目录下的 cover.jpg）。
 * 流程与音频一致：写临时文件 → 原文件改名进备份 → 临时文件改名就位。
 */
export async function processFileWrite({ jobId, seq, item, op, keepBackup = true }) {
  const target = item.path;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const temp = path.join(dir, `${TEMP_PREFIX}${jobId}-${seq}${ext}`);
  const backupRoot = op.backupRoot ?? UNDO_DIR;
  const backupDir = path.join(backupRoot, String(jobId));
  const backupPath = path.join(backupDir, `${seq}${ext}`);

  try {
    const data = Buffer.from(op.dataBase64 ?? '', 'base64');
    await fsp.mkdir(dir, { recursive: true });

    // 删除型操作：把文件改名进备份目录即完成删除，且可撤销
    if (op.kind === 'delete-file') {
      if (!fs.existsSync(target)) return { status: 'skipped', error: '文件不存在' };
      await fsp.mkdir(backupDir, { recursive: true });
      await moveFile(target, backupPath);
      return { status: 'done', backupPath: keepBackup ? backupPath : null };
    }

    if (!data.length) return { status: 'failed', error: '没有可写入的内容' };
    if (!(await ensureDiskSpace(dir, data.length * 2))) {
      return { status: 'skipped', error: '磁盘剩余空间不足' };
    }
    await fsp.writeFile(temp, data);

    let backedUp = false;
    if (fs.existsSync(target)) {
      await fsp.mkdir(backupDir, { recursive: true });
      await moveFile(target, backupPath);
      backedUp = true;
    }
    await moveFile(temp, target);
    return { status: 'done', backupPath: backedUp && keepBackup ? backupPath : null };
  } catch (err) {
    try { await fsp.rm(temp, { force: true }); } catch { /* 忽略 */ }
    return { status: 'failed', error: `${err.code ?? err.name}: ${String(err.message ?? err).slice(0, 160)}` };
  }
}

/* ------------------------------------------------------------ 索引同步 */

/**
 * 音声发行的展示字段来自「文件夹 + 曲目标签」。
 * 写回媒体标签后，只更新这次确实写到的专辑级字段；不碰发行结构（album_id/版本/轨号）。
 * 音声标题仍以文件夹/内嵌标签的既有规则为准，这里只在用户显式写了 album 标签时更新。
 */
function updateVoiceAlbumAfterWrite(albumId, patch, parsed) {
  const sets = [];
  const values = [];
  const has = (key) => Object.prototype.hasOwnProperty.call(patch ?? {}, key);

  if (has('album') && parsed.album) {
    sets.push('title = ?');
    values.push(parsed.album);
  }
  if (has('albumArtist') || has('artists')) {
    // 用户显式写了文件标签 → 下次扫描按标签重算，而不是锁成 manual
    sets.push('album_artist = ?', "album_artist_source = 'tag'");
    values.push(parsed.albumArtist || parsed.artist || null);
  }
  if (has('year')) {
    sets.push('year = ?');
    values.push(parsed.year ?? null);
  }
  if (has('genres')) {
    sets.push('genre = ?');
    values.push(parsed.genre ?? null);
  }
  if (!sets.length) return;

  sets.push('updated_at = ?');
  values.push(now());
  db.prepare(`UPDATE albums SET ${sets.join(', ')} WHERE id = ? AND kind = 'voice'`)
    .run(...values, Number(albumId));
}

/**
 * 音声曲目只就地更新**本次实际写到的字段**。
 * 不能像普通专辑那样用整份文件标签覆盖全部字段：封面任务只改 picture，
 * 若顺手把其它标签也重写一遍，会把库内手工值/DB override 冲掉。
 */
function syncVoiceTrackInPlace(existing, meta, stat, patch = {}) {
  const firstString = (v) => (Array.isArray(v) ? (v.find(Boolean) ?? '') : (v ?? ''));
  const taggedTitle = (meta.common.title ?? '').trim();
  const artist = firstString(meta.common.artist) || firstString(meta.common.artists);
  const albumArtist = firstString(meta.common.albumartist) || artist;
  const album = (meta.common.album ?? '').trim();
  const year = meta.common.year ?? null;
  const genre = firstString(meta.common.genre) || null;
  const composer = firstString(meta.common.composer) || null;
  const picture = meta.common.picture?.[0];
  const has = (key) => Object.prototype.hasOwnProperty.call(patch ?? {}, key);

  const sets = ['parse_error = NULL', 'has_cover = ?', 'size = ?', 'mtime = ?', 'updated_at = ?',
    'duration = ?', 'bitrate = ?', 'sample_rate = ?', 'channels = ?', 'codec = ?', 'container = ?'];
  const values = [
    picture ? 1 : 0,
    stat.size,
    Math.round(stat.mtimeMs),
    now(),
    meta.format.duration ?? null,
    meta.format.bitrate ?? null,
    meta.format.sampleRate ?? null,
    meta.format.numberOfChannels ?? null,
    meta.format.codec ?? null,
    meta.format.container ?? null,
  ];

  if (has('title')) {
    sets.push('title = ?', 'title_source = ?');
    values.push(
      taggedTitle || path.basename(existing.path, path.extname(existing.path)),
      taggedTitle ? 'tag' : 'filename',
    );
  }
  if (has('album')) { sets.push('album = ?'); values.push(album || null); }
  if (has('albumArtist')) { sets.push('album_artist = ?'); values.push(albumArtist || null); }
  if (has('artists')) { sets.push('artist = ?'); values.push(artist || null); }
  if (has('trackNo')) { sets.push('track_no = ?'); values.push(meta.common.track?.no ?? null); }
  if (has('discNo')) { sets.push('disc_no = ?'); values.push(meta.common.disk?.no ?? null); }
  if (has('year')) { sets.push('year = ?'); values.push(year); }
  if (has('genres')) { sets.push('genre = ?'); values.push(genre); }
  if (has('composers')) { sets.push('composer = ?'); values.push(composer); }

  const metadataWritten = ['title', 'album', 'albumArtist', 'artists',
    'trackNo', 'discNo', 'year', 'genres', 'composers'].some(has);
  if (metadataWritten) sets.push("meta_source = 'file'", 'override_json = NULL');

  db.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE id = ?`).run(...values, existing.id);
  return { album, albumArtist, artist, year, genre };
}

/** 写回后用重新解析的结果同步索引（不信任编辑表单里的值） */
export async function syncTrackIndex(trackId, patch = {}) {
  const existing = db.prepare('SELECT id, path, album_id FROM tracks WHERE id = ?').get(Number(trackId));
  if (!existing) return false;
  const filePath = existing.path;

  let stat;
  try { stat = await fsp.stat(filePath); } catch { return false; }
  const meta = await parseFile(filePath, { duration: true, skipCovers: false }).catch(() => null);
  if (!meta) return false;

  const firstString = (v) => (Array.isArray(v) ? (v.find(Boolean) ?? '') : (v ?? ''));
  const taggedTitle = (meta.common.title ?? '').trim();
  const artist = firstString(meta.common.artist) || firstString(meta.common.artists);
  const albumArtist = firstString(meta.common.albumartist) || artist;
  const album = (meta.common.album ?? '').trim();
  const dir = path.dirname(filePath);
  const year = meta.common.year ?? null;
  const genre = firstString(meta.common.genre) || null;
  const picture = meta.common.picture?.[0];
  const previous = db.prepare('SELECT library_id FROM tracks WHERE id = ?').get(existing.id);

  const albumRow = existing.album_id
    ? db.prepare('SELECT id, kind FROM albums WHERE id = ?').get(existing.album_id)
    : null;

  /*
   * 音声发行的曲目**不能**走 resolveAlbumForTrack：
   * 它按 album/albumArtist/dir 重算 `music` 专辑键，会把音声曲目从三层模型里
   * 挪到一张新的普通专辑，后面的版本/轨号/发行根关系全部断掉。
   * 这里只就地更新标签字段，保留 album_id、版本、轨号与压缩包来源字段。
   */
  if (albumRow?.kind === 'voice') {
    const parsed = syncVoiceTrackInPlace(existing, meta, stat, patch);
    updateVoiceAlbumAfterWrite(albumRow.id, patch, parsed);
    return true;
  }

  // 注意：必须把 album/albumArtist/year/genre 全部传给重聚合，
  // 否则专辑级字段不会被更新（coalesce 会保留旧值）
  const resolved = resolveAlbumForTrack({
    id: existing.id, album, albumArtist, artist, dir, year, genre,
  });

  upsertTrack({
    path: filePath,
    dir,
    libraryId: previous?.library_id ?? null,
    filename: path.basename(filePath),
    ext: path.extname(filePath).toLowerCase(),
    size: stat.size,
    mtime: Math.round(stat.mtimeMs),
    title: taggedTitle || path.basename(filePath, path.extname(filePath)),
    titleSource: taggedTitle ? 'tag' : 'filename',
    artist: artist || null,
    albumArtist: albumArtist || null,
    album: album || null,
    albumKey: resolved.albumKey,
    albumId: resolved.albumId,
    trackNo: meta.common.track?.no ?? null,
    discNo: meta.common.disk?.no ?? null,
    year,
    genre,
    composer: firstString(meta.common.composer) || null,
    duration: meta.format.duration ?? null,
    bitrate: meta.format.bitrate ?? null,
    sampleRate: meta.format.sampleRate ?? null,
    channels: meta.format.numberOfChannels ?? null,
    codec: meta.format.codec ?? null,
    container: meta.format.container ?? null,
    hasCover: Boolean(picture),
    parseError: null,
  });

  // 写回/撤销后按曲目实际标签重算专辑展示字段——
  // 否则「删掉流派」这类操作会因为 coalesce 策略而留在专辑上
  recomputeAlbumFields(resolved.albumId);
  return true;
}

/* ------------------------------------------------------------ 编辑计划 */

/** 专辑级字段（作用于专辑内全部曲目） */
const ALBUM_SCOPED = ['album', 'albumArtist', 'year', 'genres', 'composers', 'picture'];
/** 曲目级字段（只作用于选中的那一首） */
const TRACK_SCOPED = ['title', 'trackNo', 'discNo', 'comment', 'artists'];

const FIELD_LABELS = {
  title: '曲名', album: '专辑名', albumArtist: '专辑艺术家', artists: '艺术家',
  trackNo: '音轨号', discNo: '碟号', year: '年份', genres: '流派',
  composers: '作曲家', comment: '注释', picture: '封面',
};

/** 字段校验（设计文档 5.3.4） */
export function validateFields(fields = {}) {
  const errors = [];
  const str = (v) => String(v ?? '').trim();

  if ('title' in fields && !str(fields.title)) errors.push('曲名不能为空');
  if (str(fields.title).length > 200) errors.push('曲名最多 200 个字符');
  if ('album' in fields && !str(fields.album)) errors.push('专辑名不能为空');
  if (str(fields.album).length > 200) errors.push('专辑名最多 200 个字符');
  if (str(fields.albumArtist).length > 200) errors.push('专辑艺术家最多 200 个字符');

  const range = (key, min, max, label) => {
    if (!(key in fields)) return;
    const n = Number(fields[key]);
    if (!Number.isFinite(n) || n < min || n > max) errors.push(`${label}必须是 ${min}–${max} 之间的整数`);
  };
  range('trackNo', 1, 999, '音轨号');
  range('discNo', 1, 999, '碟号');
  range('year', 1000, 2100, '年份');

  const genres = fields.genres;
  if (genres !== undefined) {
    const list = Array.isArray(genres) ? genres : [genres];
    if (list.some((g) => str(g).length > 60)) errors.push('单个流派最多 60 个字符');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 把一次编辑翻译成逐曲目的补丁、快照与影响清单（不写任何文件）。
 *
 * fields/clear          专辑级字段（scope='album' 时作用于全部曲目）
 * scope='track'         只作用于 trackId 指向的那一首
 * trackOverrides/Clears 逐曲目覆盖，形如 { [trackId]: { title, trackNo } }
 */
export function planMetadataEdit({
  albumId, trackId = null, fields = {}, clear = [], scope = 'album',
  trackOverrides = {}, trackClears = {},
}) {
  const validation = validateFields(fields);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  const rows = trackId
    ? [getTrack(trackId)].filter(Boolean)
    : listAlbumTracks(albumId).map((t) => getTrack(t.id)).filter(Boolean);
  if (!rows.length) return { ok: false, errors: ['没有可编辑的曲目'] };

  /** 把一组字段+清空列表翻成 taglib 补丁 */
  const buildPatchFrom = (fieldsIn, clearIn, isTargetTrack) => {
    const patch = {};
    for (const [key, value] of Object.entries(fieldsIn ?? {})) {
      if (value === undefined) continue;
      // scope='album' 时，曲目级字段只作用于显式指定的那一首
      if (scope === 'album' && TRACK_SCOPED.includes(key) && !isTargetTrack) continue;
      if (value === '' || value === null) continue; // 留空 = 不修改
      if (key === 'year' || key === 'trackNo' || key === 'discNo') {
        const n = Number(value);
        if (!Number.isFinite(n)) continue;
        patch[key] = n;
      } else if (key === 'genres' || key === 'artists' || key === 'composers') {
        const list = (Array.isArray(value) ? value : [value]).map((v) => String(v).trim()).filter(Boolean);
        if (list.length) patch[key] = list;
      } else {
        patch[key] = String(value).trim();
      }
    }
    for (const key of clearIn ?? []) {
      if (key === 'picture') patch.picture = null;
      else if (key === 'genres' || key === 'composers' || key === 'artists') patch[key] = [];
      else if (key === 'trackNo' || key === 'discNo' || key === 'year') patch[key] = null;
      else patch[key] = '';
    }
    return patch;
  };

  const patches = {};
  const snapshots = {};
  const changes = [];

  for (const track of rows) {
    const isTarget = trackId ? track.id === Number(trackId) : false;
    const patch = buildPatchFrom(fields, clear, isTarget);

    const override = trackOverrides?.[String(track.id)];
    const trackClearList = trackClears?.[String(track.id)] ?? [];
    if ((override && Object.keys(override).length) || trackClearList.length) {
      Object.assign(patch, buildPatchFrom(override ?? {}, trackClearList, true));
    }

    if (!Object.keys(patch).length) continue;

    const archiveMember = track.source_kind === 'archive_member' || track.archive_id != null;
    const writable = isWritableTrack(track);
    patches[String(track.id)] = patch;
    snapshots[String(track.id)] = { size: track.size, mtime: track.mtime };
    changes.push({
      trackId: track.id,
      path: track.path,
      filename: track.filename,
      writable,
      readonlyReason: writable
        ? null
        : (archiveMember ? '压缩包内文件只读' : `格式不支持写回（${track.ext || '未知'}）`),
      before: {
        title: track.title, album: track.album, albumArtist: track.album_artist,
        year: track.year, genre: track.genre, trackNo: track.track_no, discNo: track.disc_no,
      },
      after: patch,
      changedFields: Object.keys(patch).map((k) => FIELD_LABELS[k] ?? k),
    });
  }

  if (!changes.length) return { ok: false, errors: ['没有任何字段发生变化'] };

  const writableChanges = changes.filter((c) => c.writable);

  return {
    ok: true,
    // 不可写文件也放进任务：执行器会逐条标记 skipped（格式不支持 / 压缩包内只读），
    // 任务历史里因此能如实说明「为什么没写」。UI 在 files=0 时会阻止发起任务。
    items: changes.map((c) => ({ trackId: c.trackId, path: c.path })),
    patches,
    snapshots,
    changes,
    summary: {
      files: writableChanges.length,
      total: changes.length,
      writable: writableChanges.length,
      unsupported: changes.length - writableChanges.length,
      fields: [...new Set(changes.flatMap((c) => c.changedFields))],
    },
  };
}

/* ---------------------------------------------------------------- 执行器 */

function setJobStatus(jobId, status, extra = {}) {
  const fields = Object.entries(extra).map(([k]) => `${k} = ?`).join(', ');
  const values = Object.values(extra);
  db.prepare(`UPDATE write_jobs SET status = ?${fields ? `, ${fields}` : ''} WHERE id = ?`)
    .run(status, ...values, jobId);
}

function setItemStatus(jobId, seq, status, error = null, backupFile = null) {
  db.prepare(`
    UPDATE write_job_items SET status = ?, error = ?, backup_file = ?
    WHERE job_id = ? AND id = (SELECT id FROM write_job_items WHERE job_id = ? ORDER BY id LIMIT 1 OFFSET ?)
  `).run(status, error, backupFile, jobId, jobId, seq);
}

/**
 * 顺序执行写任务（单写者：避免机械盘随机写抖动，也避免同专辑部分成功的中间态）。
 * 返回最终统计。
 */
export async function runJob(jobId, { writer = writeTags, onProgress = null } = {}) {
  if (currentJobId !== null) {
    const err = new Error('已有写任务在进行中');
    err.code = 'WRITE_BUSY';
    throw err;
  }
  currentJobId = jobId;
  setJobStatus(jobId, 'running');

  const stats = { succeeded: 0, skipped: 0, failed: 0 };
  try {
    const items = db.prepare('SELECT * FROM write_job_items WHERE job_id = ? ORDER BY id').all(jobId);
    const payload = JSON.parse(
      db.prepare('SELECT payload_json FROM write_jobs WHERE id = ?').get(jobId).payload_json ?? '{}',
    );
    // 整张专辑共用的封面只存一份，逐曲目引用它，避免 payload 膨胀
    const jobPicture = payload.picture?.dataBase64
      ? {
        data: Buffer.from(payload.picture.dataBase64, 'base64'),
        mimeType: payload.picture.mimeType ?? 'image/jpeg',
        description: payload.picture.description ?? 'front',
      }
      : null;

    for (let seq = 0; seq < items.length; seq += 1) {
      const item = items[seq];
      const operation = payload.operations?.[String(seq)];

      // 非音频文件写操作（目录封面等）
      if (!item.track_id && operation) {
        const result = await processFileWrite({ jobId, seq, item, op: operation });
        setItemStatus(jobId, seq, result.status, result.error ?? null, result.backupPath ?? null);
        if (result.status === 'done') stats.succeeded += 1;
        else if (result.status === 'skipped') stats.skipped += 1;
        else stats.failed += 1;
        db.prepare('UPDATE write_jobs SET succeeded = ?, skipped = ?, failed = ? WHERE id = ?')
          .run(stats.succeeded, stats.skipped, stats.failed, jobId);
        if (onProgress) onProgress({ seq, total: items.length, ...stats });
        continue;
      }

      const track = item.track_id ? getTrack(item.track_id) : null;
      if (!track) {
        setItemStatus(jobId, seq, 'skipped', '曲目索引已不存在');
        stats.skipped += 1;
        continue;
      }

      let patch = payload.patches?.[String(item.track_id)] ?? payload.patch ?? {};
      if (patch?.picture?.useJobPicture) {
        patch = { ...patch, picture: jobPicture };
      }
      const snapshot = payload.snapshots?.[String(item.track_id)] ?? null;

      const result = await processFile({ jobId, seq, track, patch, writer, snapshot });
      setItemStatus(jobId, seq, result.status, result.error ?? null, result.backupPath ?? null);
      if (result.status === 'done') {
        stats.succeeded += 1;
        await syncTrackIndex(item.track_id, patch).catch(() => {});
      } else if (result.status === 'skipped') {
        stats.skipped += 1;
      } else {
        stats.failed += 1;
      }

      db.prepare('UPDATE write_jobs SET succeeded = ?, skipped = ?, failed = ? WHERE id = ?')
        .run(stats.succeeded, stats.skipped, stats.failed, jobId);
      if (onProgress) onProgress({ seq, total: items.length, ...stats });
    }

    setJobStatus(jobId, 'done', {
      finished_at: now(),
      succeeded: stats.succeeded,
      skipped: stats.skipped,
      failed: stats.failed,
    });
    return stats;
  } catch (err) {
    setJobStatus(jobId, 'failed', { finished_at: now(), error: String(err.message ?? err) });
    throw err;
  } finally {
    currentJobId = null;
  }
}

/* ---------------------------------------------------------------- 撤销 */

/** 从备份还原：本身也是一次写任务（可再次撤销 = 重做） */
export async function undoJob(jobId) {
  const job = getJob(jobId);
  if (!job) throw new Error('写任务不存在');
  if (!['done', 'failed', 'interrupted'].includes(job.status)) {
    throw new Error(`当前状态（${job.status}）不可撤销`);
  }

  const restorable = job.items.filter((item) => item.backup_file && fs.existsSync(item.backup_file));
  if (!restorable.length) throw new Error('没有可还原的备份文件');
  // 撤销后按「原任务写过的字段」重新解析还原文件，音声卡片才能跟着回退。
  const undoPatches = job.payload?.patches ?? {};

  if (currentJobId !== null) {
    const err = new Error('已有写任务在进行中');
    err.code = 'WRITE_BUSY';
    throw err;
  }

  const undoInfo = db.prepare(`
    INSERT INTO write_jobs (type, status, payload_json, total, created_at)
    VALUES ('undo', 'running', ?, ?, ?)
  `).run(JSON.stringify({ undoOf: jobId }), restorable.length, now());
  const undoId = Number(undoInfo.lastInsertRowid);

  currentJobId = undoId;
  const stats = { restored: 0, failed: 0 };
  try {
    for (const item of restorable) {
      const target = item.path;
      const dir = path.dirname(target);
      const ext = path.extname(target);
      const temp = path.join(dir, `${TEMP_PREFIX}undo-${undoId}${ext}`);
      try {
        await fsp.copyFile(item.backup_file, temp);
        if (fs.existsSync(target)) await fsp.rm(target, { force: true });
        await fsp.rename(temp, target);
        stats.restored += 1;
        if (item.track_id) {
          await syncTrackIndex(item.track_id, undoPatches[String(item.track_id)] ?? {})
            .catch(() => {});
        }
      } catch (err) {
        stats.failed += 1;
        try { await fsp.rm(temp, { force: true }); } catch { /* 忽略 */ }
        console.error(`[undo] ${target} 还原失败：${err.message}`);
      }
    }
    // 音声标题/艺术家不一定能只靠还原文件推回来（例如原文件没有 album 标签），
    // 所以撤销时按写前快照把专辑展示字段也一并还原。
    const albumSnapshot = job.payload?.albumSnapshot;
    const albumId = job.payload?.albumId;
    if (albumSnapshot && albumId) {
      db.prepare(`
        UPDATE albums SET title = ?, album_artist = ?, album_artist_source = ?,
          year = ?, genre = ?, artist_suggested = ?, artist_decision = ?
        WHERE id = ?
      `).run(
        albumSnapshot.title ?? null,
        albumSnapshot.album_artist ?? null,
        albumSnapshot.album_artist_source ?? null,
        albumSnapshot.year ?? null,
        albumSnapshot.genre ?? null,
        albumSnapshot.artist_suggested ?? null,
        albumSnapshot.artist_decision ?? null,
        Number(albumId),
      );
    }

    setJobStatus(undoId, 'done', { finished_at: now(), succeeded: stats.restored, failed: stats.failed });
    db.prepare("UPDATE write_jobs SET status = 'undone' WHERE id = ?").run(jobId);
    return { undoJobId: undoId, ...stats };
  } finally {
    currentJobId = null;
  }
}

/* ------------------------------------------------------- 启动时一致性检查 */

/**
 * 处理上次进程中断留下的痕迹：
 *   原路径缺失 + 备份存在 + 临时文件存在 → 崩溃于「备份后、替换前」→ 自动还原
 *   原路径存在 + 临时文件存在          → 崩溃于「复制后、备份前」→ 清理临时文件
 */
export async function recoverInterruptedWrites() {
  const jobs = db.prepare("SELECT * FROM write_jobs WHERE status = 'interrupted'").all();
  const report = { restored: 0, cleaned: 0, jobs: jobs.length };
  for (const job of jobs) {
    const items = db.prepare('SELECT * FROM write_job_items WHERE job_id = ?').all(job.id);
    for (const item of items) {
      const tempExists = fs.existsSync(item.path)
        ? fs.readdirSync(path.dirname(item.path)).some((f) => f.startsWith(TEMP_PREFIX) && f.includes(`-${job.id}-`))
        : false;
      const targetExists = fs.existsSync(item.path);
      const backupExists = item.backup_file ? fs.existsSync(item.backup_file) : false;

      if (!targetExists && backupExists) {
        try {
          await fsp.rename(item.backup_file, item.path);
          report.restored += 1;
        } catch { /* 留给人工处理 */ }
      }
      if (tempExists) {
        for (const f of fs.readdirSync(path.dirname(item.path))) {
          if (f.startsWith(TEMP_PREFIX) && f.includes(`-${job.id}-`)) {
            await fsp.rm(path.join(path.dirname(item.path), f), { force: true }).catch(() => {});
            report.cleaned += 1;
          }
        }
      }
    }
  }
  return report;
}

/** 清理残留的 .lam-tmp-* 文件（扫描前调用） */
export async function cleanupTempFiles(rootDir) {
  let removed = 0;
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === UNDO_DIR_NAME || entry.name.startsWith('.')) continue;
        stack.push(full);
      } else if (entry.name.startsWith(TEMP_PREFIX)) {
        await fsp.rm(full, { force: true }).catch(() => {});
        removed += 1;
      }
    }
  }
  return removed;
}
