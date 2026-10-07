/**
 * 用户资产导出/导入与自动备份（设计文档 6.5、D16）。
 *
 * 索引数据可以重建，但下面这些是用户手工成果，删了就没了：
 *   库显示名、标签与打标关系、完整性豁免、手工封面选择、歌词人工关联。
 */
import fs from 'node:fs';
import path from 'node:path';

import { BACKUP_DIR, ensureDirs } from './config.mjs';
import { db, getMeta, setMeta, listLibraries } from './db.mjs';

export const ASSET_VERSION = 1;
const AUTO_BACKUP_KEEP = 10;

function albumRef(row) {
  return {
    albumKey: row.album_key,
    album: row.title,
    albumArtist: row.album_artist,
    year: row.year,
  };
}

/** 导出全部用户资产为可移植的 JSON 结构 */
export function exportUserAssets() {
  const libraries = listLibraries().map((l) => ({ path: l.path, displayName: l.display_name }));
  const tags = db.prepare('SELECT id, name, color, pinned FROM tags ORDER BY id').all();

  const albumTags = db.prepare(`
    SELECT a.album_key, a.title, a.album_artist, tg.name AS tag
    FROM album_tags at
    JOIN albums a ON a.id = at.album_id
    JOIN tags tg ON tg.id = at.tag_id
  `).all().map((r) => ({ albumKey: r.album_key, album: r.title, tag: r.tag }));

  const ignores = db.prepare(`
    SELECT a.album_key, ai.key FROM album_ignore ai
    JOIN albums a ON a.id = ai.album_id
  `).all().map((r) => ({ albumKey: r.album_key, key: r.key }));

  const covers = db.prepare(`
    SELECT album_key, title, cover_hash, cover_file, cover_source
    FROM albums WHERE cover_source = 'manual' AND cover_hash IS NOT NULL
  `).all().map((r) => ({
    albumKey: r.album_key, album: r.title, hash: r.cover_hash, file: r.cover_file, source: r.cover_source,
  }));

  const lyricsLinks = db.prepare(`
    SELECT path, lyrics_path FROM tracks WHERE lyrics_path IS NOT NULL
  `).all().map((r) => ({ path: r.path, lyricsPath: r.lyrics_path }));

  const overrides = db.prepare(`
    SELECT path, album_key, override_json FROM tracks
    WHERE meta_source = 'db-override' AND override_json IS NOT NULL
  `).all().map((r) => ({ path: r.path, albumKey: r.album_key, fields: JSON.parse(r.override_json) }));

  return {
    version: ASSET_VERSION,
    exportedAt: Date.now(),
    libraries,
    tags: tags.map((t) => ({ name: t.name, color: t.color, pinned: Boolean(t.pinned) })),
    albumTags,
    ignores,
    manualCovers: covers,
    lyricsLinks,
    overrides,
  };
}

function findOrCreateTag(name, color) {
  const existing = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(String(name));
  if (existing) return existing.id;
  const t = Date.now();
  const info = db.prepare('INSERT INTO tags (name, color, pinned, created_at, updated_at) VALUES (?, ?, 0, ?, ?)')
    .run(String(name), Number(color) || 0, t, t);
  return info.lastInsertRowid;
}

function albumIdByKey(albumKey) {
  return db.prepare('SELECT id FROM albums WHERE album_key = ?').get(String(albumKey))?.id ?? null;
}

/** 导入用户资产（合并语义：只增不减，不覆盖已存在的标签关联） */
export function importUserAssets(payload) {
  if (!payload || payload.version !== ASSET_VERSION) {
    throw new Error(`资产文件版本不支持（需要 ${ASSET_VERSION}）`);
  }
  const result = { libraries: 0, tags: 0, tagLinks: 0, ignores: 0, covers: 0, lyrics: 0, missingAlbums: 0 };
  const t = Date.now();

  db.exec('BEGIN');
  try {
    for (const lib of payload.libraries ?? []) {
      const exists = db.prepare('SELECT id FROM libraries WHERE path = ? COLLATE NOCASE').get(lib.path);
      if (exists) {
        if (lib.displayName) {
          db.prepare('UPDATE libraries SET display_name = ? WHERE id = ?').run(lib.displayName, exists.id);
        }
      } else {
        db.prepare('INSERT INTO libraries (path, added_at, display_name) VALUES (?, ?, ?)')
          .run(lib.path, t, lib.displayName ?? null);
        result.libraries += 1;
      }
    }

    for (const tag of payload.tags ?? []) {
      const before = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(tag.name);
      const id = findOrCreateTag(tag.name, tag.color);
      if (!before) result.tags += 1;
      if (tag.pinned) db.prepare('UPDATE tags SET pinned = 1 WHERE id = ?').run(id);
    }

    for (const link of payload.albumTags ?? []) {
      const albumId = albumIdByKey(link.albumKey);
      if (!albumId) { result.missingAlbums += 1; continue; }
      const tagId = findOrCreateTag(link.tag, 0);
      result.tagLinks += db.prepare(
        "INSERT OR IGNORE INTO album_tags (album_id, tag_id, source, added_at) VALUES (?, ?, 'manual', ?)",
      ).run(albumId, tagId, t).changes;
    }

    for (const item of payload.ignores ?? []) {
      const albumId = albumIdByKey(item.albumKey);
      if (!albumId) continue;
      result.ignores += db.prepare(
        'INSERT OR IGNORE INTO album_ignore (album_id, key, created_at) VALUES (?, ?, ?)',
      ).run(albumId, item.key, t).changes;
    }

    for (const cover of payload.manualCovers ?? []) {
      const albumId = albumIdByKey(cover.albumKey);
      if (!albumId) continue;
      db.prepare(`
        UPDATE albums SET cover_hash = ?, cover_file = ?, cover_source = 'manual', cover_updated_at = ?
        WHERE id = ?
      `).run(cover.hash, cover.file, t, albumId);
      result.covers += 1;
    }

    for (const link of payload.lyricsLinks ?? []) {
      result.lyrics += db.prepare('UPDATE tracks SET lyrics_path = ? WHERE path = ?')
        .run(link.lyricsPath, link.path).changes;
    }

    for (const item of payload.overrides ?? []) {
      db.prepare(`
        UPDATE tracks SET meta_source = 'db-override', override_json = ? WHERE path = ?
      `).run(JSON.stringify(item.fields), item.path);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return result;
}

/** 自动备份：每次用户资产变更后落一份（保留最近 N 份） */
export function writeAutoBackup(reason = 'auto') {
  ensureDirs();
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const payload = { ...exportUserAssets(), reason };
    const file = path.join(BACKUP_DIR, `user-assets-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    setMeta('user_assets_backup_at', String(Date.now()));

    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('user-assets-') && f.endsWith('.json'))
      .sort();
    while (files.length > AUTO_BACKUP_KEEP) {
      const oldest = files.shift();
      fs.rmSync(path.join(BACKUP_DIR, oldest), { force: true });
    }
    return file;
  } catch {
    return null;
  }
}

export function listAutoBackups() {
  ensureDirs();
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('user-assets-') && f.endsWith('.json'))
      .sort()
      .reverse()
      .map((f) => {
        const full = path.join(BACKUP_DIR, f);
        const stat = fs.statSync(full);
        return { file: f, size: stat.size, mtime: stat.mtimeMs };
      });
  } catch {
    return [];
  }
}

export function lastBackupAt() {
  const raw = getMeta('user_assets_backup_at');
  return raw ? Number(raw) : null;
}
