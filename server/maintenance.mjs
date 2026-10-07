/**
 * 维护任务（设计文档 D1 / rev.2 推论 3）：
 * - 回收 data/covers 下不再被任何专辑引用的封面文件
 * - 清空缩略图缓存（内容可由原图重建）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { COVER_DIR, THUMB_DIR, ensureDirs } from './config.mjs';
import { referencedCoverFiles, db, deleteAlbumIfEmpty } from './db.mjs';

/**
 * 回收孤儿封面文件。dryRun=true 时只统计不删除。
 * 返回 { files, bytes, kept }
 */
export function collectOrphanCovers({ dryRun = false } = {}) {
  ensureDirs();
  const referenced = referencedCoverFiles();
  const targets = [];

  if (fs.existsSync(COVER_DIR)) {
    for (const name of fs.readdirSync(COVER_DIR)) {
      const full = path.join(COVER_DIR, name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!stat.isFile()) continue;
      if (referenced.has(name)) continue;
      targets.push({ full, size: stat.size });
    }
  }

  // 缩略图可由原图重建，属于纯缓存，可以整目录回收
  if (fs.existsSync(THUMB_DIR)) {
    for (const name of fs.readdirSync(THUMB_DIR)) {
      const full = path.join(THUMB_DIR, name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!stat.isFile()) continue;
      targets.push({ full, size: stat.size });
    }
  }

  let bytes = 0;
  let files = 0;
  for (const item of targets) {
    bytes += item.size;
    files += 1;
    if (!dryRun) {
      try { fs.rmSync(item.full, { force: true }); } catch { /* 单个文件失败不影响其他 */ }
    }
  }

  return { files, bytes, kept: referenced.size, dryRun };
}

/** 磁盘占用概览（设置/统计页展示） */
export function coverStorageUsage() {
  let bytes = 0;
  let count = 0;
  for (const dir of [COVER_DIR, THUMB_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      try {
        const stat = fs.statSync(path.join(dir, name));
        if (stat.isFile()) { bytes += stat.size; count += 1; }
      } catch { /* 忽略 */ }
    }
  }
  return { files: count, bytes };
}

/**
 * 找出「数据库有封面记录、但磁盘文件已丢失」的专辑（返回 albumId 列表）。
 * 这类专辑在界面上会显示裂图，应当清空引用以便重新提取。
 */
export function albumsWithMissingCoverFiles(rows) {
  const broken = [];
  for (const row of rows) {
    if (!row.cover_file) continue;
    if (!fs.existsSync(path.join(COVER_DIR, row.cover_file))) broken.push(row.id);
  }
  return broken;
}

/** 判断某个封面文件是否真实存在 */
export function coverFileExists(fileName) {
  if (!fileName) return false;
  return fs.existsSync(path.join(COVER_DIR, path.basename(fileName)));
}

const IMAGE_MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
};

/** 按内容寻址把封面图片写入 data/covers（同一张图只存一份） */
export function persistCoverImage(buffer, mime, source = 'manual') {
  ensureDirs();
  const hash = crypto.createHash('sha1').update(buffer).digest('hex');
  const ext = IMAGE_MIME_EXT[String(mime).toLowerCase()] ?? '.jpg';
  const file = `${hash}${ext}`;
  const target = path.join(COVER_DIR, file);
  if (!fs.existsSync(target)) fs.writeFileSync(target, buffer);
  return { hash, file, mime, source };
}

/** 通过文件头魔数判断真实图片格式（不信任扩展名） */
export function detectImageMime(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF'
    && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  return null;
}

/**
 * 清理「索引里有、磁盘上已不存在」的曲目记录。
 * 用于修复索引与磁盘漂移（例如外部挪动/删除文件后没重新扫描）。
 */
export function pruneMissingTracks() {
  const rows = db.prepare('SELECT id, path, album_id FROM tracks').all();
  const missing = rows.filter((row) => {
    try { return !fs.existsSync(row.path); } catch { return true; }
  });

  let removed = 0;
  for (const row of missing) {
    db.prepare('DELETE FROM tracks WHERE id = ?').run(row.id);
    if (row.album_id) deleteAlbumIfEmpty(row.album_id);
    removed += 1;
  }
  return { removed, sample: missing.slice(0, 10).map((r) => r.path) };
}

/** 清理没有任何曲目的空专辑 */
export function pruneEmptyAlbums() {
  const info = db.prepare(`
    DELETE FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL)
  `).run();
  return { removed: info.changes };
}
