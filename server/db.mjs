/**
 * 数据层（V2）：连接、表结构、V1→V2 迁移、音乐库/曲目/专辑/封面的全部读写。
 * 标签见 tags.mjs，完整性见 completeness.mjs。
 *
 * 设计要点（见产品设计文档 6.x）：
 * - 专辑以 albums.id 为稳定身份，album_key 仅作"聚合计算依据"，可随元数据变化而更新
 * - 索引数据可重建，但 albums/tags 承载用户资产，必须可导出（assets.mjs）
 */
import fs from 'node:fs';
import path from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import {
  DB_FILE, DATA_DIR, BACKUP_DIR, ensureDirs, albumKeyOf, normalizeText,
} from './config.mjs';

export const SCHEMA_VERSION = 6;
export const PLACEHOLDER_ALBUM = '(未知专辑)';
export const PLACEHOLDER_ARTIST = '(未知艺术家)';

ensureDirs();

export const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
`);

const now = () => Date.now();

/* ==================================================================== schema */

function tableExists(name) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

function columnNames(table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
  } catch {
    return [];
  }
}

/** V1 基础表：只建 libraries 与 tracks（covers 由 V1 建立，迁移时并入 albums） */
function createBaseTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS libraries (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      path          TEXT NOT NULL UNIQUE,
      added_at      INTEGER NOT NULL,
      last_scan_at  INTEGER,
      track_count   INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tracks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      path          TEXT NOT NULL UNIQUE,
      dir           TEXT NOT NULL,
      library_id    INTEGER,
      filename      TEXT NOT NULL,
      ext           TEXT,
      size          INTEGER,
      mtime         INTEGER,
      title         TEXT,
      artist        TEXT,
      album_artist  TEXT,
      album         TEXT,
      album_key     TEXT NOT NULL,
      track_no      INTEGER,
      disc_no       INTEGER,
      year          INTEGER,
      genre         TEXT,
      composer      TEXT,
      duration      REAL,
      bitrate       INTEGER,
      sample_rate   INTEGER,
      channels      INTEGER,
      codec         TEXT,
      container     TEXT,
      has_cover     INTEGER NOT NULL DEFAULT 0,
      parse_error   TEXT,
      added_at      INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tracks_album_key ON tracks(album_key);
    CREATE INDEX IF NOT EXISTS idx_tracks_artist    ON tracks(artist);
    CREATE INDEX IF NOT EXISTS idx_tracks_album     ON tracks(album);
    CREATE INDEX IF NOT EXISTS idx_tracks_library   ON tracks(library_id);
  `);
}

/** V2 表：专辑实体、标签、豁免、写任务、元信息 */
function createV2Tables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS albums (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      album_key         TEXT NOT NULL UNIQUE,
      title             TEXT,
      album_artist      TEXT,
      year              INTEGER,
      genre             TEXT,
      is_compilation    INTEGER NOT NULL DEFAULT 0,
      cover_hash        TEXT,
      cover_file        TEXT,
      cover_mime        TEXT,
      cover_source      TEXT,
      cover_updated_at  INTEGER,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(album_artist);
    CREATE INDEX IF NOT EXISTS idx_albums_title  ON albums(title);
    CREATE INDEX IF NOT EXISTS idx_albums_year   ON albums(year);

    CREATE TABLE IF NOT EXISTS tags (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL COLLATE NOCASE UNIQUE,
      color       INTEGER NOT NULL DEFAULT 0,
      pinned      INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS album_tags (
      album_id  INTEGER NOT NULL,
      tag_id    INTEGER NOT NULL,
      source    TEXT NOT NULL DEFAULT 'manual',
      added_at  INTEGER NOT NULL,
      PRIMARY KEY (album_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_album_tags_tag ON album_tags(tag_id);

    CREATE TABLE IF NOT EXISTS album_ignore (
      album_id    INTEGER NOT NULL,
      key         TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (album_id, key)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key    TEXT PRIMARY KEY,
      value  TEXT
    );

    CREATE TABLE IF NOT EXISTS write_jobs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      type          TEXT NOT NULL,
      status        TEXT NOT NULL,
      payload_json  TEXT,
      total         INTEGER NOT NULL DEFAULT 0,
      succeeded     INTEGER NOT NULL DEFAULT 0,
      skipped       INTEGER NOT NULL DEFAULT 0,
      failed        INTEGER NOT NULL DEFAULT 0,
      backup_dir    TEXT,
      error         TEXT,
      created_at    INTEGER NOT NULL,
      finished_at   INTEGER
    );

    CREATE TABLE IF NOT EXISTS write_job_items (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id       INTEGER NOT NULL,
      track_id     INTEGER,
      path         TEXT NOT NULL,
      status       TEXT NOT NULL,
      error        TEXT,
      backup_file  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_job_items_job ON write_job_items(job_id);

    -- V3：音声「版本」层（一个发行下可有多个版本：本篇/无音效/无饮尿/视频版…）
    CREATE TABLE IF NOT EXISTS album_versions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      album_id          INTEGER NOT NULL,
      name              TEXT NOT NULL,
      name_key          TEXT NOT NULL,
      group_kind        TEXT NOT NULL DEFAULT 'main',
      preferred_format  TEXT,
      dir_path          TEXT,
      file_count        INTEGER NOT NULL DEFAULT 0,
      total_bytes       INTEGER NOT NULL DEFAULT 0,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      UNIQUE(album_id, name_key, group_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_album_versions_album ON album_versions(album_id);

    -- V3：人工对「相似轨道是否合并」的确认结论
    CREATE TABLE IF NOT EXISTS track_merge_decisions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      album_id    INTEGER NOT NULL,
      key_a       TEXT NOT NULL,
      key_b       TEXT NOT NULL,
      decision    TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      UNIQUE(album_id, key_a, key_b)
    );
  `);
}

/**
 * V6 表：压缩包（P1 只读虚拟库）
 * 见 docs/压缩包支持设计.md §5.2。
 * 压缩包**永远只读**：这里只登记清单与统计，不代表任何写回意图。
 */
function createV6Tables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS archives (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id        INTEGER,
      path              TEXT NOT NULL UNIQUE,
      format            TEXT NOT NULL DEFAULT 'zip',
      entry_count       INTEGER NOT NULL DEFAULT 0,
      audio_count       INTEGER NOT NULL DEFAULT 0,
      image_count       INTEGER NOT NULL DEFAULT 0,
      video_count       INTEGER NOT NULL DEFAULT 0,
      packed_bytes      INTEGER NOT NULL DEFAULT 0,
      unpacked_bytes    INTEGER NOT NULL DEFAULT 0,
      encrypted         INTEGER NOT NULL DEFAULT 0,
      unsupported       INTEGER NOT NULL DEFAULT 0,
      name_encoding     TEXT,
      status            TEXT NOT NULL DEFAULT 'ready',
      error             TEXT,
      file_size         INTEGER,
      file_mtime        INTEGER,
      scanned_at        INTEGER,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_archives_library ON archives(library_id);
    CREATE INDEX IF NOT EXISTS idx_archives_status  ON archives(status);

    -- 包内清单：P1 用于增量比对与统计，P2 用于按需取成员
    CREATE TABLE IF NOT EXISTS archive_members (
      archive_id   INTEGER NOT NULL,
      member_path  TEXT NOT NULL,
      kind         TEXT,
      size         INTEGER,
      packed_size  INTEGER,
      method       INTEGER,
      crc32        INTEGER,
      mtime        INTEGER,
      name_encoding TEXT,
      PRIMARY KEY (archive_id, member_path)
    );
    CREATE INDEX IF NOT EXISTS idx_archive_members_kind ON archive_members(archive_id, kind);
  `);
}

function addV2Columns() {
  const wanted = {
    libraries: [['display_name', 'TEXT']],
    tracks: [
      ['album_id', 'INTEGER'],
      ['meta_source', "TEXT NOT NULL DEFAULT 'file'"],
      ['title_source', 'TEXT'],
      ['override_json', 'TEXT'],
      ['lyrics_path', 'TEXT'],
      // V3：音声三层模型
      ['version_id', 'INTEGER'],
      ['track_key', 'TEXT'],
      ['file_kind', "TEXT NOT NULL DEFAULT 'audio'"],
      ['is_bonus', 'INTEGER NOT NULL DEFAULT 0'],
      ['variant_label', 'TEXT'],
      // V5：单曲喜欢（只对普通音乐曲目生效）
      ['favorite', 'INTEGER NOT NULL DEFAULT 0'],
      ['favorite_at', 'INTEGER'],
      // V6：压缩包成员（P1 只读挂载）
      ['source_kind', "TEXT NOT NULL DEFAULT 'file'"],
      ['archive_id', 'INTEGER'],
      ['member_path', 'TEXT'],
      ['materialized_state', "TEXT NOT NULL DEFAULT 'ready'"],
    ],
    albums: [
      // V3：音声发行信息
      ['kind', "TEXT NOT NULL DEFAULT 'music'"],
      ['rj_code', 'TEXT'],
      ['release_root', 'TEXT'],
      ['has_bonus', 'INTEGER NOT NULL DEFAULT 0'],
      ['has_video', 'INTEGER NOT NULL DEFAULT 0'],
      // V4：社团 / 喜欢
      ['circle', 'TEXT'],
      ['favorite', 'INTEGER NOT NULL DEFAULT 0'],
      ['favorite_at', 'INTEGER'],
      // V5：艺术家来源与「标签建议但未采用」的值
      ['album_artist_source', 'TEXT'],
      ['artist_suggested', 'TEXT'],
      ['artist_decision', 'TEXT'],
    ],
  };
  for (const [table, columns] of Object.entries(wanted)) {
    const existing = new Set(columnNames(table));
    for (const [name, type] of columns) {
      if (!existing.has(name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tracks_album_id ON tracks(album_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_version   ON tracks(version_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_key       ON tracks(album_id, track_key);
    CREATE INDEX IF NOT EXISTS idx_albums_rj        ON albums(rj_code);
  `);
}

function addV6Columns() {
  const wanted = {
    tracks: [
      ['source_kind', "TEXT NOT NULL DEFAULT 'file'"],
      ['archive_id', 'INTEGER'],
      ['member_path', 'TEXT'],
      ['materialized_state', "TEXT NOT NULL DEFAULT 'ready'"],
    ],
  };
  for (const [table, columns] of Object.entries(wanted)) {
    const existing = new Set(columnNames(table));
    for (const [name, type] of columns) {
      if (!existing.has(name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tracks_archive ON tracks(archive_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_src     ON tracks(source_kind, materialized_state);
  `);
}

/* =============================================================== meta table */

export function getMeta(key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(String(key));
  return row ? row.value : fallback;
}

export function setMeta(key, value) {
  db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(key), String(value));
}

/* ================================================================ migration */

/** 迁移前把 V1 数据库整体备份（WAL 先落盘，避免备份缺数据） */
function backupV1Database() {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* 忽略：checkpoint 失败不阻塞迁移 */
  }
  const target = path.join(BACKUP_DIR, 'library.db.v1.bak');
  if (fs.existsSync(target)) return target; // 保留首次备份，不覆盖
  try {
    fs.copyFileSync(DB_FILE, target);
    return target;
  } catch {
    return null;
  }
}

/** 把 V1 的 album_key 分组结果回填为 albums 实体，并把 tracks 挂上去 */
function migrateV1ToV2() {
  const backup = backupV1Database();

  db.exec('BEGIN');
  try {
    const groups = db.prepare(`
      SELECT t.album_key                                    AS album_key,
             MIN(NULLIF(TRIM(t.album), ''))                 AS title,
             MIN(NULLIF(TRIM(t.album_artist), ''))          AS album_artist,
             MIN(t.year)                                    AS year,
             MIN(NULLIF(TRIM(t.genre), ''))                 AS genre,
             MIN(t.added_at)                                AS created_at,
             MAX(t.updated_at)                              AS updated_at
      FROM tracks t
      GROUP BY t.album_key
    `).all();

    const insertAlbum = db.prepare(`
      INSERT INTO albums (album_key, title, album_artist, year, genre, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const linkTracks = db.prepare('UPDATE tracks SET album_id = ? WHERE album_key = ?');

    for (const g of groups) {
      const info = insertAlbum.run(
        g.album_key, g.title ?? null, g.album_artist ?? null, g.year ?? null,
        g.genre ?? null, g.created_at ?? now(), g.updated_at ?? now(),
      );
      linkTracks.run(info.lastInsertRowid, g.album_key);
    }

    // V1 的 covers 表并入 albums
    if (tableExists('covers')) {
      const covers = db.prepare('SELECT * FROM covers').all();
      const updateCover = db.prepare(`
        UPDATE albums SET cover_hash = ?, cover_file = ?, cover_mime = ?, cover_source = ?, cover_updated_at = ?
        WHERE album_key = ?
      `);
      for (const c of covers) {
        updateCover.run(c.hash, c.file, c.mime, c.source ?? 'folder', c.updated_at ?? now(), c.album_key);
      }
      db.exec('DROP TABLE covers');
    }

    // 回填 title_source：V1 在标签缺失时把文件名当作标题，用同名启发式还原
    db.exec(`
      UPDATE tracks
      SET title_source = CASE
        WHEN title IS NULL THEN 'filename'
        WHEN title = REPLACE(filename, ext, '') THEN 'filename'
        ELSE 'tag'
      END
      WHERE title_source IS NULL
    `);

    // 回填库显示名
    db.exec("UPDATE libraries SET display_name = NULL WHERE display_name = ''");

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { groups: db.prepare('SELECT COUNT(*) AS n FROM albums').get().n, backup };
}

export const migrationReport = { from: null, to: SCHEMA_VERSION, migrated: false, albums: 0, backup: null };

function migrate() {
  const hadTracks = tableExists('tracks');
  const hadMeta = tableExists('meta');

  createBaseTables();
  createV2Tables();
  addV2Columns();
  createV6Tables();
  addV6Columns();

  let version;
  if (hadMeta) {
    version = Number(getMeta('schema_version', '1')) || 1;
  } else if (hadTracks) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n;
    version = count > 0 ? 1 : SCHEMA_VERSION; // 空库视为全新
  } else {
    version = SCHEMA_VERSION;
  }

  migrationReport.from = version;
  migrationReport.to = SCHEMA_VERSION;
  if (version < 2) {
    const result = migrateV1ToV2();
    migrationReport.migrated = true;
    migrationReport.albums = result.groups;
    migrationReport.backup = result.backup;
  } else if (version < SCHEMA_VERSION) {
    // v2/v3/v4/v5 → v6：只补新表与新列，无需重建专辑
    migrationReport.migrated = true;
    migrationReport.note = `v${version} → v${SCHEMA_VERSION}：新增音声版本表、社团与喜欢字段、压缩包清单表`;
  }
  setMeta('schema_version', String(SCHEMA_VERSION));
  return migrationReport;
}

migrate();

/* ================================================================ libraries */

const LIBRARY_SELECT = `
  SELECT l.id, l.path, l.display_name, l.added_at, l.last_scan_at,
         COALESCE(l.display_name, '') AS display_name_resolved,
         (SELECT COUNT(*) FROM tracks t WHERE t.library_id = l.id) AS track_count
  FROM libraries l
`;

/** 显示名解析：别名优先，否则取路径末段 */
export function libraryDisplayName(row) {
  const alias = normalizeText(row?.display_name);
  if (alias) return alias;
  const p = String(row?.path ?? '');
  const base = path.basename(p);
  return base || p;
}

function decorateLibrary(row) {
  return row ? { ...row, display_name: libraryDisplayName(row) } : null;
}

export function listLibraries() {
  return db.prepare(`${LIBRARY_SELECT} ORDER BY l.path COLLATE NOCASE`).all().map(decorateLibrary);
}

export function getLibrary(id) {
  return decorateLibrary(db.prepare(`${LIBRARY_SELECT} WHERE l.id = ?`).get(Number(id)) ?? null);
}

export function findLibraryByPath(p) {
  return decorateLibrary(db.prepare(`${LIBRARY_SELECT} WHERE l.path = ? COLLATE NOCASE`).get(String(p)) ?? null);
}

export function addLibrary(p, displayName = null) {
  const existing = findLibraryByPath(p);
  if (existing) return existing;
  const info = db.prepare('INSERT INTO libraries (path, added_at, display_name) VALUES (?, ?, ?)')
    .run(String(p), now(), normalizeText(displayName) || null);
  return getLibrary(info.lastInsertRowid);
}

export function renameLibrary(id, displayName) {
  const name = normalizeText(displayName);
  db.prepare('UPDATE libraries SET display_name = ? WHERE id = ?').run(name || null, Number(id));
  return getLibrary(id);
}

export function removeLibrary(id) {
  const lib = getLibrary(id);
  if (!lib) return false;

  // 防御性清理：既按 library_id 删，也按路径前缀删——
  // 这样即使历史上出现过 library_id 丢失的孤儿记录，也能被一并清掉
  const prefix = lib.path.endsWith(path.sep) ? lib.path : `${lib.path}${path.sep}`;
  const albumIds = db.prepare(`
    SELECT DISTINCT album_id FROM tracks
    WHERE library_id = ? OR lower(substr(path, 1, ?)) = lower(?)
  `).all(Number(id), prefix.length, prefix).map((r) => r.album_id).filter(Boolean);

  db.prepare(`
    DELETE FROM tracks WHERE library_id = ? OR lower(substr(path, 1, ?)) = lower(?)
  `).run(Number(id), prefix.length, prefix);
  db.prepare('DELETE FROM libraries WHERE id = ?').run(Number(id));
  for (const albumId of albumIds) deleteAlbumIfEmpty(albumId);
  return true;
}

export function touchLibrary(id, { lastScanAt = now() } = {}) {
  db.prepare('UPDATE libraries SET last_scan_at = ? WHERE id = ?').run(Number(lastScanAt), Number(id));
}

/* =================================================================== albums */

function rowToAlbum(row) {
  if (!row) return null;
  return {
    ...row,
    is_compilation: Boolean(row.is_compilation),
    is_voice: row.kind === 'voice',
    has_bonus: Boolean(row.has_bonus),
    has_video: Boolean(row.has_video),
    display_title: row.title || PLACEHOLDER_ALBUM,
    display_artist: row.album_artist || PLACEHOLDER_ARTIST,
  };
}

export function getAlbumById(id) {
  return rowToAlbum(db.prepare('SELECT * FROM albums WHERE id = ?').get(Number(id)) ?? null);
}

export function findAlbumByKey(albumKey) {
  return rowToAlbum(db.prepare('SELECT * FROM albums WHERE album_key = ?').get(String(albumKey)) ?? null);
}

export function getAlbumByKeyOrFail(albumKey) {
  const album = findAlbumByKey(albumKey);
  if (!album) throw new Error('专辑不存在');
  return album;
}

export function countAlbums() {
  return db.prepare('SELECT COUNT(*) AS n FROM albums').get().n;
}

function createAlbum(albumKey, patch = {}) {
  const t = now();
  const info = db.prepare(`
    INSERT INTO albums (album_key, title, album_artist, year, genre, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    albumKey, patch.title ?? null, patch.album_artist ?? null,
    patch.year ?? null, patch.genre ?? null, t, t,
  );
  return Number(info.lastInsertRowid);
}

/** 按专辑内曲目的标签重新计算展示字段（不保留旧值，用于写回/撤销后的索引同步） */
export function recomputeAlbumFields(albumId) {
  const row = db.prepare(`
    SELECT MIN(NULLIF(TRIM(title), ''))        AS title,
           MIN(NULLIF(TRIM(album_artist), '')) AS album_artist,
           MIN(NULLIF(TRIM(album), ''))        AS album,
           MIN(year)                           AS year,
           MIN(NULLIF(TRIM(genre), ''))        AS genre
    FROM tracks WHERE album_id = ?
  `).get(Number(albumId));
  if (!row) return false;

  db.prepare(`
    UPDATE albums SET title = ?, album_artist = ?, year = ?, genre = ?, updated_at = ? WHERE id = ?
  `).run(
    row.album ?? row.title ?? null,
    row.album_artist ?? null,
    row.year ?? null,
    row.genre ?? null,
    now(),
    Number(albumId),
  );
  return true;
}

/** 用新解析出的字段更新专辑显示信息；coalesce=只填空值，不覆盖已有非空值 */
export function updateAlbumFields(albumId, patch = {}, { coalesce = true } = {}) {
  const album = getAlbumById(albumId);
  if (!album) return false;
  const pick = (key) => {
    const next = patch[key];
    if (next === undefined) return album[key];
    if (coalesce && (next === null || next === '') && album[key]) return album[key];
    return next ?? null;
  };
  db.prepare(`
    UPDATE albums SET title = ?, album_artist = ?, year = ?, genre = ?, updated_at = ? WHERE id = ?
  `).run(
    pick('title'), pick('album_artist'), pick('year'), pick('genre'), now(), albumId,
  );
  return true;
}

/** 单曲喜欢：只对普通音乐曲目生效；音声曲目不参与（返回 skipped） */
export function setTrackFavorite(trackId, flag) {
  const row = db.prepare(`
    SELECT t.id, COALESCE(a.kind, 'music') AS kind
    FROM tracks t LEFT JOIN albums a ON a.id = t.album_id WHERE t.id = ?
  `).get(Number(trackId));
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.kind === 'voice') return { ok: true, skipped: true, favorite: false };
  db.prepare('UPDATE tracks SET favorite = ?, favorite_at = ?, updated_at = ? WHERE id = ?')
    .run(flag ? 1 : 0, flag ? now() : null, now(), Number(trackId));
  return { ok: true, skipped: false, favorite: Boolean(flag) };
}

export function countFavoriteTracks() {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM tracks t LEFT JOIN albums a ON a.id = t.album_id
    WHERE t.favorite = 1 AND COALESCE(a.kind, 'music') <> 'voice'
  `).get().n;
}

/**
 * 找出「作品名或发行根路径里包含给定文字」的其他音声发行。
 * 用于把用户填过一次的社团/艺术家自动套用到同名社团的其他作品。
 */
export function voiceAlbumsMatching(text, { excludeId = null } = {}) {
  const rows = db.prepare(`
    SELECT id, COALESCE(title, '') AS title, COALESCE(release_root, '') AS release_root,
           COALESCE(circle, '') AS circle, COALESCE(album_artist, '') AS album_artist
    FROM albums WHERE kind = 'voice'
  `).all();
  return rows.filter((r) => r.id !== Number(excludeId));
}

/** 批量写入社团（只写库，不动文件） */
export function setAlbumCircleBulk(ids, circle) {
  const value = String(circle ?? '').trim() || null;
  const t = now();
  const stmt = db.prepare('UPDATE albums SET circle = ?, updated_at = ? WHERE id = ?');
  let n = 0;
  for (const id of ids) { stmt.run(value, t, Number(id)); n += 1; }
  return n;
}

/** 批量写入艺术家（只写库，不动文件）；标记为手工来源，永不被扫描覆盖 */
export function setAlbumArtistBulk(ids, artist) {
  const value = String(artist ?? '').trim() || null;
  const t = now();
  const stmt = db.prepare(`UPDATE albums SET album_artist = ?, album_artist_source = ?,
    artist_suggested = NULL, updated_at = ? WHERE id = ?`);
  let n = 0;
  for (const id of ids) { stmt.run(value, value ? 'manual' : null, t, Number(id)); n += 1; }
  return n;
}

/** 手工写入单个专辑的艺术家 */
export function setAlbumArtistManual(albumId, artist) {
  return setAlbumArtistBulk([albumId], artist) === 1;
}

/** 采用「标签里建议但未被采纳」的艺术家 */
export function adoptSuggestedArtist(albumId) {
  db.prepare(`UPDATE albums SET album_artist = artist_suggested, album_artist_source = 'manual',
    artist_suggested = NULL, artist_decision = 'adopted', updated_at = ?
    WHERE id = ? AND artist_suggested IS NOT NULL`).run(now(), Number(albumId));
  return getAlbumById(albumId);
}

/**
 * 对「标签建议」做出选择。
 *   adopted → 把建议的艺术家作为显示值
 *   kept    → 保持软件已识别到的艺术家不变
 * 两种选择都会清掉提示，且重新扫描不再重复提示。
 */
export function setArtistDecision(albumId, decision) {
  const id = Number(albumId);
  if (decision === 'adopted') return adoptSuggestedArtist(id);
  db.prepare(`UPDATE albums SET artist_suggested = NULL, artist_decision = 'kept',
    updated_at = ? WHERE id = ?`).run(now(), id);
  return getAlbumById(id);
}

/**
 * 专辑艺术家显示值（与 listAlbums 里的 ALBUM_ARTIST 同一规则）。
 * 全部曲目艺术家一致、且包含专辑艺术家标签并更长时，用曲目艺术家更准确。
 */
export function computeDisplayArtist(albumArtist, trackArtists) {
  const a = String(albumArtist ?? '').trim();
  const distinct = [...new Set((trackArtists ?? [])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean))];
  if (a && distinct.length === 1
      && distinct[0].includes(a) && distinct[0].length > a.length) {
    return distinct[0];
  }
  return a || distinct[0] || PLACEHOLDER_ARTIST;
}

/** 喜欢（收藏）：写库即可，不涉及任何文件改动 */
export function setAlbumFavorite(albumId, flag) {
  db.prepare('UPDATE albums SET favorite = ?, favorite_at = ?, updated_at = ? WHERE id = ?')
    .run(flag ? 1 : 0, flag ? now() : null, now(), Number(albumId));
  return Boolean(flag);
}

/** 社团名称：写库即可（与艺术家一样，不写回音频文件） */
export function setAlbumCircle(albumId, circle) {
  const value = String(circle ?? '').trim() || null;
  db.prepare('UPDATE albums SET circle = ?, updated_at = ? WHERE id = ?')
    .run(value, now(), Number(albumId));
  return value;
}

export function setAlbumCompilation(albumId, flag) {
  db.prepare('UPDATE albums SET is_compilation = ?, updated_at = ? WHERE id = ?')
    .run(flag ? 1 : 0, now(), Number(albumId));
}

/** 把 tracks.album_key 同步为专辑当前的 key（诊断与兼容用） */
function syncTrackAlbumKey(albumId) {
  const album = getAlbumById(albumId);
  if (!album) return;
  db.prepare('UPDATE tracks SET album_key = ? WHERE album_id = ?').run(album.album_key, albumId);
}

export function deleteAlbumIfEmpty(albumId) {
  const left = db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE album_id = ?').get(Number(albumId)).n;
  if (left > 0) return false;
  db.prepare('DELETE FROM album_tags WHERE album_id = ?').run(Number(albumId));
  db.prepare('DELETE FROM album_ignore WHERE album_id = ?').run(Number(albumId));
  db.prepare('DELETE FROM albums WHERE id = ?').run(Number(albumId));
  return true;
}

/** 专辑合并：source 并入 target（标签并集、豁免并集、封面补缺），随后删除空壳 source */
export function mergeAlbums(sourceId, targetId) {
  const source = getAlbumById(sourceId);
  const target = getAlbumById(targetId);
  if (!source || !target || source.id === target.id) return { moved: 0, tags: 0 };

  const moved = db.prepare('UPDATE tracks SET album_id = ? WHERE album_id = ?')
    .run(target.id, source.id).changes;

  const tags = db.prepare(`
    INSERT OR IGNORE INTO album_tags (album_id, tag_id, source, added_at)
    SELECT ?, tag_id, source, added_at FROM album_tags WHERE album_id = ?
  `).run(target.id, source.id).changes;
  db.prepare('DELETE FROM album_tags WHERE album_id = ?').run(source.id);

  db.prepare(`
    INSERT OR IGNORE INTO album_ignore (album_id, key, created_at)
    SELECT ?, key, created_at FROM album_ignore WHERE album_id = ?
  `).run(target.id, source.id);
  db.prepare('DELETE FROM album_ignore WHERE album_id = ?').run(source.id);

  if (!target.cover_hash && source.cover_hash) {
    db.prepare(`
      UPDATE albums SET cover_hash = ?, cover_file = ?, cover_mime = ?, cover_source = ?, cover_updated_at = ?
      WHERE id = ?
    `).run(source.cover_hash, source.cover_file, source.cover_mime, source.cover_source, now(), target.id);
  }
  db.prepare("UPDATE albums SET is_compilation = MAX(is_compilation, ?) WHERE id = ?")
    .run(source.is_compilation ? 1 : 0, target.id);

  deleteAlbumIfEmpty(source.id);
  return { moved, tags };
}

/**
 * 决定一个曲目应归属哪张专辑（设计文档 6.3 的重聚合算法）。
 * - 纯改名：复用同一实体（id 不变，标签/封面/豁免全保留）
 * - 撞键：把当前专辑合并进目标专辑（标签并集）
 */
export function resolveAlbumForTrack(track = {}) {
  const newKey = albumKeyOf({
    album: track.album, albumArtist: track.albumArtist, artist: track.artist, dir: track.dir,
  });
  const patch = {
    title: normalizeText(track.album) || null,
    album_artist: normalizeText(track.albumArtist) || normalizeText(track.artist) || null,
    year: Number.isFinite(track.year) ? track.year : null,
    genre: normalizeText(track.genre) || null,
  };

  const currentAlbum = track.id
    ? getAlbumById(db.prepare('SELECT album_id FROM tracks WHERE id = ?').get(track.id)?.album_id)
    : null;

  if (!currentAlbum) {
    const existing = findAlbumByKey(newKey);
    if (existing) {
      updateAlbumFields(existing.id, patch);
      return { albumId: existing.id, albumKey: newKey, action: 'attached' };
    }
    return { albumId: createAlbum(newKey, patch), albumKey: newKey, action: 'created' };
  }

  if (currentAlbum.album_key === newKey) {
    updateAlbumFields(currentAlbum.id, patch);
    return { albumId: currentAlbum.id, albumKey: newKey, action: 'unchanged' };
  }

  const target = findAlbumByKey(newKey);
  if (target && target.id !== currentAlbum.id) {
    mergeAlbums(currentAlbum.id, target.id);
    updateAlbumFields(target.id, patch);
    syncTrackAlbumKey(target.id);
    return { albumId: target.id, albumKey: newKey, action: 'merged', mergedFrom: currentAlbum.id };
  }

  db.prepare('UPDATE albums SET album_key = ?, updated_at = ? WHERE id = ?')
    .run(newKey, now(), currentAlbum.id);
  updateAlbumFields(currentAlbum.id, patch);
  syncTrackAlbumKey(currentAlbum.id);
  return { albumId: currentAlbum.id, albumKey: newKey, action: 'renamed' };
}

/** 手工把若干曲目移动到指定专辑（V2.3 的"合并/移出"能力基础） */
export function moveTracksToAlbum(trackIds, albumId) {
  const stmt = db.prepare('UPDATE tracks SET album_id = ? WHERE id = ?');
  let n = 0;
  for (const id of trackIds) n += stmt.run(Number(albumId), Number(id)).changes;
  syncTrackAlbumKey(albumId);
  return n;
}

/* =================================================================== tracks */

const UPSERT_TRACK = `
  INSERT INTO tracks (
    path, dir, library_id, filename, ext, size, mtime,
    title, artist, album_artist, album, album_key, album_id,
    track_no, disc_no, year, genre, composer,
    duration, bitrate, sample_rate, channels, codec, container,
    has_cover, parse_error, title_source, meta_source, override_json, lyrics_path,
    version_id, track_key, file_kind, is_bonus, variant_label,
    source_kind, archive_id, member_path, materialized_state,
    added_at, updated_at
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?
  )
  ON CONFLICT(path) DO UPDATE SET
    dir = excluded.dir, library_id = excluded.library_id, filename = excluded.filename,
    ext = excluded.ext, size = excluded.size, mtime = excluded.mtime,
    title = excluded.title, artist = excluded.artist, album_artist = excluded.album_artist,
    album = excluded.album, album_key = excluded.album_key, album_id = excluded.album_id,
    track_no = excluded.track_no, disc_no = excluded.disc_no, year = excluded.year,
    genre = excluded.genre, composer = excluded.composer,
    duration = excluded.duration, bitrate = excluded.bitrate, sample_rate = excluded.sample_rate,
    channels = excluded.channels, codec = excluded.codec, container = excluded.container,
    has_cover = excluded.has_cover, parse_error = excluded.parse_error,
    title_source = excluded.title_source,
    version_id = excluded.version_id, track_key = excluded.track_key,
    file_kind = excluded.file_kind, is_bonus = excluded.is_bonus,
    variant_label = excluded.variant_label,
    source_kind = excluded.source_kind, archive_id = excluded.archive_id,
    member_path = excluded.member_path, materialized_state = excluded.materialized_state,
    updated_at = excluded.updated_at
`;

export function upsertTrack(rec) {
  const t = now();
  db.prepare(UPSERT_TRACK).run(
    rec.path, rec.dir, rec.libraryId ?? null, rec.filename, rec.ext ?? null,
    rec.size ?? null, rec.mtime ?? null,
    rec.title ?? null, rec.artist ?? null, rec.albumArtist ?? null,
    rec.album ?? null, rec.albumKey, rec.albumId ?? null,
    rec.trackNo ?? null, rec.discNo ?? null, rec.year ?? null,
    rec.genre ?? null, rec.composer ?? null,
    rec.duration ?? null, rec.bitrate ?? null, rec.sampleRate ?? null,
    rec.channels ?? null, rec.codec ?? null, rec.container ?? null,
    rec.hasCover ? 1 : 0, rec.parseError ?? null,
    rec.titleSource ?? null, rec.metaSource ?? 'file', rec.overrideJson ?? null,
    rec.lyricsPath ?? null,
    rec.versionId ?? null, rec.trackKey ?? null, rec.fileKind ?? 'audio',
    rec.isBonus ? 1 : 0, rec.variantLabel ?? null,
    rec.sourceKind ?? 'file', rec.archiveId ?? null, rec.memberPath ?? null,
    rec.materializedState ?? (rec.archiveId ? 'archived' : 'ready'),
    rec.addedAt ?? t, t,
  );
}

export function findTrackByPath(p) {
  return db.prepare('SELECT id, size, mtime, album_id, library_id FROM tracks WHERE path = ?')
    .get(String(p)) ?? null;
}

export function getTrack(id) {
  return db.prepare(`
    SELECT t.*, a.title AS album_title, a.album_artist AS album_artist_name,
           a.cover_hash, a.cover_mime
    FROM tracks t LEFT JOIN albums a ON a.id = t.album_id
    WHERE t.id = ?
  `).get(Number(id)) ?? null;
}

export function deleteTrackByPath(p) {
  const row = db.prepare('SELECT id, album_id FROM tracks WHERE path = ?').get(String(p));
  if (!row) return false;
  db.prepare('DELETE FROM tracks WHERE path = ?').run(String(p));
  if (row.album_id) deleteAlbumIfEmpty(row.album_id);
  return true;
}

export function trackPathsInLibrary(libraryId) {
  return db.prepare('SELECT path FROM tracks WHERE library_id = ?').all(Number(libraryId)).map((r) => r.path);
}

export function countTracksInLibrary(libraryId) {
  return db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE library_id = ?').get(Number(libraryId)).n;
}

/* ================================================================= 压缩包 */

/**
 * 登记（或更新）一个压缩包，并整体替换它的成员清单。
 * 压缩包永远只读：这里只写 Luna 自己的索引。
 *
 * @param {object} rec { path, libraryId, format, entryCount, audioCount, imageCount,
 *                       videoCount, packedBytes, unpackedBytes, encrypted,
 *                       unsupported, nameEncoding, status, error, fileSize, fileMtime }
 * @param {Array<object>} members 成员清单（可空）
 * @returns {number} archive id
 */
export function upsertArchive(rec = {}, members = []) {
  const t = now();
  const existing = db.prepare('SELECT id, created_at FROM archives WHERE path = ?').get(String(rec.path));
  let id;
  if (existing) {
    id = existing.id;
    db.prepare(`
      UPDATE archives SET
        library_id = ?, format = ?, entry_count = ?, audio_count = ?, image_count = ?,
        video_count = ?, packed_bytes = ?, unpacked_bytes = ?, encrypted = ?,
        unsupported = ?, name_encoding = ?, status = ?, error = ?,
        file_size = ?, file_mtime = ?, scanned_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      rec.libraryId ?? null, rec.format ?? 'zip',
      rec.entryCount ?? 0, rec.audioCount ?? 0, rec.imageCount ?? 0, rec.videoCount ?? 0,
      rec.packedBytes ?? 0, rec.unpackedBytes ?? 0, rec.encrypted ? 1 : 0,
      rec.unsupported ? 1 : 0, rec.nameEncoding ?? null,
      rec.status ?? 'ready', rec.error ?? null,
      rec.fileSize ?? null, rec.fileMtime ?? null, t, id,
    );
  } else {
    const info = db.prepare(`
      INSERT INTO archives (
        library_id, path, format, entry_count, audio_count, image_count, video_count,
        packed_bytes, unpacked_bytes, encrypted, unsupported, name_encoding,
        status, error, file_size, file_mtime, scanned_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rec.libraryId ?? null, String(rec.path), rec.format ?? 'zip',
      rec.entryCount ?? 0, rec.audioCount ?? 0, rec.imageCount ?? 0, rec.videoCount ?? 0,
      rec.packedBytes ?? 0, rec.unpackedBytes ?? 0, rec.encrypted ? 1 : 0,
      rec.unsupported ? 1 : 0, rec.nameEncoding ?? null,
      rec.status ?? 'ready', rec.error ?? null,
      rec.fileSize ?? null, rec.fileMtime ?? null, t, t, t,
    );
    id = Number(info.lastInsertRowid);
  }

  // 成员清单整体替换：先删后插，保证包内容变化后不残留旧成员
  db.prepare('DELETE FROM archive_members WHERE archive_id = ?').run(id);
  if (Array.isArray(members) && members.length) {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO archive_members
        (archive_id, member_path, kind, size, packed_size, method, crc32, mtime, name_encoding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const m of members) {
      insert.run(id, m.name, m.kind ?? 'other', m.size ?? 0, m.packedSize ?? 0,
        m.method ?? 0, m.crc32 ?? 0, m.mtime ?? null, m.nameEncoding ?? null);
    }
  }
  return id;
}

export function getArchiveByPath(p) {
  return db.prepare('SELECT * FROM archives WHERE path = ?').get(String(p)) ?? null;
}

export function getArchiveById(id) {
  return db.prepare('SELECT * FROM archives WHERE id = ?').get(Number(id)) ?? null;
}

export function listArchives({ libraryId = null, status = null } = {}) {
  const where = [];
  const args = [];
  if (libraryId != null) { where.push('library_id = ?'); args.push(Number(libraryId)); }
  if (status) { where.push('status = ?'); args.push(String(status)); }
  const sql = `SELECT * FROM archives ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY path`;
  return db.prepare(sql).all(...args);
}

export function listArchiveMembers(archiveId, kind = null) {
  const sql = kind
    ? 'SELECT * FROM archive_members WHERE archive_id = ? AND kind = ? ORDER BY member_path'
    : 'SELECT * FROM archive_members WHERE archive_id = ? ORDER BY member_path';
  const args = kind ? [Number(archiveId), String(kind)] : [Number(archiveId)];
  return db.prepare(sql).all(...args);
}

export function countArchiveMembers(archiveId) {
  return db.prepare('SELECT COUNT(*) AS n FROM archive_members WHERE archive_id = ?')
    .get(Number(archiveId)).n;
}

/** 路径前缀下的所有压缩包（重扫单个发行用） */
export function archivesUnder(rootPath) {
  const prefix = String(rootPath);
  return db.prepare('SELECT * FROM archives WHERE path = ? OR path LIKE ? ORDER BY path')
    .all(prefix, `${prefix}${path.sep}%`);
}

/** 删除一个压缩包登记及其成员与曲目；返回删除的曲目数 */
export function deleteArchive(archiveId) {
  const id = Number(archiveId);
  const row = db.prepare('SELECT path FROM archives WHERE id = ?').get(id);
  if (!row) return { tracks: 0, removed: false };
  const albumIds = db.prepare('SELECT DISTINCT album_id FROM tracks WHERE archive_id = ? AND album_id IS NOT NULL')
    .all(id).map((r) => r.album_id);
  const tracks = db.prepare('DELETE FROM tracks WHERE archive_id = ?').run(id).changes;
  db.prepare('DELETE FROM archive_members WHERE archive_id = ?').run(id);
  db.prepare('DELETE FROM archives WHERE id = ?').run(id);
  for (const albumId of albumIds) deleteAlbumIfEmpty(albumId);
  return { tracks, removed: true, path: row.path };
}

export function countTracksInArchive(archiveId) {
  return db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE archive_id = ?')
    .get(Number(archiveId)).n;
}

/**
 * 某个压缩包内的全部曲目路径。
 * 注意：不能用 trackPathsUnder()——它按 `路径 + 分隔符` 前缀匹配，
 * 而压缩包内成员路径的首段是 NUL 分隔符，永远匹配不到。
 */
export function trackPathsInArchive(archiveId) {
  return db.prepare('SELECT path FROM tracks WHERE archive_id = ?')
    .all(Number(archiveId)).map((r) => r.path);
}

/** 某个发行卡是否含有归档态曲目（界面角标用） */
export function albumArchiveInfo(albumId) {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT t.archive_id) AS archives,
           COUNT(*)                     AS tracks
    FROM tracks t
    WHERE t.album_id = ? AND t.source_kind = 'archive_member'
  `).get(Number(albumId));
  return { archives: Number(row?.archives ?? 0), tracks: Number(row?.tracks ?? 0) };
}

export function archiveStats() {
  const a = db.prepare(`
    SELECT COUNT(*) AS archives,
           COALESCE(SUM(entry_count), 0)    AS entries,
           COALESCE(SUM(audio_count), 0)    AS audio,
           COALESCE(SUM(packed_bytes), 0)   AS packed,
           COALESCE(SUM(unpacked_bytes), 0) AS unpacked,
           COALESCE(SUM(unsupported), 0)    AS unsupported,
           COALESCE(SUM(encrypted), 0)      AS encrypted
    FROM archives
  `).get();
  const t = db.prepare(`
    SELECT COUNT(*) AS tracks,
           COALESCE(SUM(CASE WHEN materialized_state = 'archived' THEN 1 ELSE 0 END), 0) AS archived
    FROM tracks WHERE source_kind = 'archive_member'
  `).get();
  return {
    archives: Number(a.archives),
    entries: Number(a.entries),
    audio: Number(a.audio),
    packedBytes: Number(a.packed),
    unpackedBytes: Number(a.unpacked),
    unsupportedArchives: Number(a.unsupported),
    encryptedArchives: Number(a.encrypted),
    archiveTracks: Number(t.tracks),
    archivedTracks: Number(t.archived),
  };
}

/* =================================================================== covers */

/**
 * 应用封面候选。优先级 manual > embedded > folder（设计文档 5.4.1）。
 * 返回 true 表示已更新。
 */
export function applyCover(albumId, { hash, file, mime, source = 'folder' }) {
  const album = getAlbumById(albumId);
  if (!album) return false;
  const rank = { manual: 3, embedded: 2, folder: 1 };
  const currentRank = album.cover_hash ? (rank[album.cover_source] ?? 0) : 0;
  const nextRank = rank[source] ?? 0;
  if (album.cover_hash === hash) return false;
  if (nextRank < currentRank) return false;
  if (nextRank === currentRank && album.cover_hash === hash) return false;

  db.prepare(`
    UPDATE albums SET cover_hash = ?, cover_file = ?, cover_mime = ?, cover_source = ?, cover_updated_at = ?
    WHERE id = ?
  `).run(hash, file, mime, source, now(), albumId);
  db.prepare('UPDATE tracks SET has_cover = 1 WHERE album_id = ?').run(albumId);
  return true;
}

export function clearCover(albumId) {
  db.prepare(`
    UPDATE albums SET cover_hash = NULL, cover_file = NULL, cover_mime = NULL,
                      cover_source = NULL, cover_updated_at = ? WHERE id = ?
  `).run(now(), Number(albumId));
  db.prepare('UPDATE tracks SET has_cover = 0 WHERE album_id = ?').run(Number(albumId));
}

/** 用户手动指定的封面（优先级最高，不会被扫描时的自动提取覆盖） */
export function setManualCover(albumId, { hash, file, mime }) {
  db.prepare(`
    UPDATE albums SET cover_hash = ?, cover_file = ?, cover_mime = ?, cover_source = 'manual',
                      cover_updated_at = ? WHERE id = ?
  `).run(hash, file, mime, now(), Number(albumId));
  db.prepare('UPDATE tracks SET has_cover = 1 WHERE album_id = ?').run(Number(albumId));
  return getAlbumById(albumId);
}

export function getCoverByHash(hash) {
  return db.prepare(`
    SELECT cover_hash AS hash, cover_file AS file, cover_mime AS mime, cover_source AS source
    FROM albums WHERE cover_hash = ? LIMIT 1
  `).get(String(hash)) ?? null;
}

/** 仍被引用的封面文件集合（用于回收孤儿图片，修复 D1） */
export function referencedCoverFiles() {
  return new Set(db.prepare('SELECT cover_file FROM albums WHERE cover_file IS NOT NULL')
    .all().map((r) => r.cover_file));
}

export function albumsMissingCover() {
  return db.prepare(`
    SELECT a.id, a.album_key, (SELECT MIN(dir) FROM tracks t WHERE t.album_id = a.id) AS dir
    FROM albums a
    WHERE a.cover_hash IS NULL
  `).all();
}

/** 专辑的封面引用（供扫描时校验文件是否存在） */
export function albumsWithCoverFiles() {
  return db.prepare(`
    SELECT id, album_key, cover_file FROM albums WHERE cover_file IS NOT NULL
  `).all();
}

/** 取专辑的第一首曲目（用于恢复内嵌封面） */
export function firstTrackOfAlbum(albumId) {
  return db.prepare(`
    SELECT id, path, filename, ext FROM tracks WHERE album_id = ?
    ORDER BY COALESCE(disc_no, 1), COALESCE(track_no, 9999), filename COLLATE NOCASE LIMIT 1
  `).get(Number(albumId)) ?? null;
}

export function markAlbumHasCover(albumId, hasCover = true) {
  db.prepare('UPDATE tracks SET has_cover = ? WHERE album_id = ?')
    .run(hasCover ? 1 : 0, Number(albumId));
}

/** 扫描收尾：让每条曲目的 has_cover 与其专辑的封面状态一致 */
export function syncCoverFlags() {
  db.exec(`
    UPDATE tracks SET has_cover = 1
    WHERE album_id IN (SELECT id FROM albums WHERE cover_hash IS NOT NULL);
    UPDATE tracks SET has_cover = 0
    WHERE album_id IS NULL OR album_id IN (SELECT id FROM albums WHERE cover_hash IS NULL);
  `);
}

/* ============================================== V3：音声发行（三层模型） */

/** 音声发行的专辑键：按发行根路径唯一 */
export function voiceAlbumKey(releaseRoot) {
  return `voice\u0000${String(releaseRoot).toLowerCase()}`;
}

export function findVoiceAlbum(releaseRoot) {
  return rowToAlbum(db.prepare('SELECT * FROM albums WHERE album_key = ?')
    .get(voiceAlbumKey(releaseRoot)) ?? null);
}

/**
 * 创建或更新一个音声发行对应的专辑卡片。
 * 专辑名优先用内嵌标签（更完整），没有标签时用文件夹名（R11）。
 *
 * 艺术家（artist 参数）只在**已通过「曲目艺术家互证」检查**时才采用；
 * 未通过的值交给 artistSuggested 记录，界面上提示用户确认，不直接写进艺术家。
 */
export function upsertVoiceAlbum({
  releaseRoot, rjCode = null, title = null, titleSource = 'folder',
  artist = null, artistSuggested = null, hasBonus = false, hasVideo = false,
}) {
  const key = voiceAlbumKey(releaseRoot);
  const existing = db.prepare('SELECT * FROM albums WHERE album_key = ?').get(key);
  const t = now();

  if (!existing) {
    const info = db.prepare(`
      INSERT INTO albums (album_key, title, album_artist, album_artist_source, artist_suggested,
                          is_compilation, kind, rj_code, release_root, has_bonus, has_video,
                          created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 'voice', ?, ?, ?, ?, ?, ?)
    `).run(key, title ?? null, artist ?? null, artist ? 'tag' : null, artistSuggested ?? null,
      rjCode, releaseRoot, hasBonus ? 1 : 0, hasVideo ? 1 : 0, t, t);
    return Number(info.lastInsertRowid);
  }

  // 标题：标签优先；标签没有时才用文件夹名
  const nextTitle = titleSource === 'tag' && title ? title : (existing.title ?? title);
  // 用户手工填过艺术家 → 永不被扫描覆盖；
  // 否则每次扫描都按「曲目互证」的最新结论重算（错误的标签值会被清掉，转入 artist_suggested）
  const manualArtist = existing.album_artist_source === 'manual';
  // 用户已对「标签建议」做过选择 → 不再重复提示
  const decided = Boolean(existing.artist_decision);
  db.prepare(`
    UPDATE albums SET title = ?, kind = 'voice',
      album_artist = CASE WHEN ? = 1 THEN album_artist ELSE ? END,
      album_artist_source = CASE WHEN ? = 1 THEN 'manual'
                                 WHEN ? IS NOT NULL THEN 'tag'
                                 ELSE NULL END,
      artist_suggested = ?,
      rj_code = COALESCE(?, rj_code), release_root = ?, has_bonus = ?, has_video = ?, updated_at = ?
    WHERE id = ?
  `).run(nextTitle, manualArtist ? 1 : 0, artist ?? null,
    manualArtist ? 1 : 0, artist ?? null,
    decided ? null : (artistSuggested ?? existing.artist_suggested ?? null),
    rjCode, releaseRoot, hasBonus ? 1 : 0, hasVideo ? 1 : 0, t, existing.id);
  return existing.id;
}

export function upsertAlbumVersion(albumId, {
  name, nameKey, groupKind = 'main', preferredFormat = null, dirPath = null,
  fileCount = 0, totalBytes = 0,
}) {
  const t = now();
  const existing = db.prepare(
    'SELECT id FROM album_versions WHERE album_id = ? AND name_key = ? AND group_kind = ?',
  ).get(Number(albumId), nameKey, groupKind);
  if (existing) {
    db.prepare(`
      UPDATE album_versions SET name = ?, preferred_format = ?, dir_path = ?,
        file_count = ?, total_bytes = ?, updated_at = ? WHERE id = ?
    `).run(name, preferredFormat, dirPath, fileCount, totalBytes, t, existing.id);
    return existing.id;
  }
  const info = db.prepare(`
    INSERT INTO album_versions (album_id, name, name_key, group_kind, preferred_format,
                                dir_path, file_count, total_bytes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(Number(albumId), name, nameKey, groupKind, preferredFormat, dirPath,
    fileCount, totalBytes, t, t);
  return Number(info.lastInsertRowid);
}

export function listAlbumVersions(albumId) {
  return db.prepare(`
    SELECT v.*, (SELECT COUNT(*) FROM tracks t WHERE t.version_id = v.id) AS track_count
    FROM album_versions v WHERE v.album_id = ?
    ORDER BY v.group_kind ASC,
      CASE WHEN v.name LIKE '%本篇%' OR v.name LIKE '%本編%' OR v.name LIKE '%通常%'
           THEN 0 ELSE 1 END,
      v.name COLLATE NOCASE ASC
  `).all(Number(albumId));
}

export function pruneAlbumVersions(albumId, keepIds) {
  const keep = (keepIds ?? []).map(Number).filter(Number.isFinite);
  if (!keep.length) {
    db.prepare('DELETE FROM album_versions WHERE album_id = ?').run(Number(albumId));
    return;
  }
  const placeholders = keep.map(() => '?').join(', ');
  db.prepare(`DELETE FROM album_versions WHERE album_id = ? AND id NOT IN (${placeholders})`)
    .run(Number(albumId), ...keep);
}

/** 人工合并结论（R10+ 的「待确认」落地） */
export function getMergeDecisions(albumId) {
  const rows = db.prepare(
    'SELECT key_a, key_b, decision FROM track_merge_decisions WHERE album_id = ?',
  ).all(Number(albumId));
  const merge = [];
  const separate = [];
  for (const r of rows) {
    (r.decision === 'merge' ? merge : separate).push([r.key_a, r.key_b]);
  }
  return { merge, separate };
}

export function setMergeDecision(albumId, keyA, keyB, decision) {
  const [a, b] = [keyA, keyB].sort();
  db.prepare(`
    INSERT INTO track_merge_decisions (album_id, key_a, key_b, decision, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(album_id, key_a, key_b) DO UPDATE SET decision = excluded.decision
  `).run(Number(albumId), a, b, decision, now());
  return getMergeDecisions(albumId);
}

/** 音声发行的全部曲目（含版本信息，供界面按轨号合并） */
export function listVoiceTracks(albumId) {
  return db.prepare(`
    SELECT t.id, t.path, t.filename, t.ext, t.title, t.track_no, t.track_key,
           t.file_kind, t.is_bonus, t.size, t.duration, t.version_id, t.variant_label,
           -- 压缩包状态（P1）：界面据此显示「包内」并禁止播放
           t.source_kind, t.materialized_state, t.archive_id, t.member_path,
           v.name AS version_name, v.group_kind, v.preferred_format, v.name_key AS version_key
    FROM tracks t LEFT JOIN album_versions v ON v.id = t.version_id
    WHERE t.album_id = ?
    ORDER BY COALESCE(t.track_no, 9999), t.track_key, v.name COLLATE NOCASE
  `).all(Number(albumId));
}

/** 按发行根列出已入库的曲目路径（扫描清理用） */
export function trackPathsUnder(rootPath) {
  const prefix = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;
  return db.prepare(`
    SELECT path FROM tracks WHERE lower(substr(path, 1, ?)) = lower(?)
  `).all(prefix.length, prefix).map((r) => r.path);
}

/* ================================================================== queries */

const ALBUM_TITLE = `COALESCE(NULLIF(TRIM(a.title), ''), '${PLACEHOLDER_ALBUM}')`;
/**
 * 专辑艺术家显示值。
 * 优先取「更完整的曲目艺术家」：当全部曲目艺术家一致、且它**包含**专辑艺术家标签并更长时，
 * 说明标签里的值是不完整写法（例如标签 "KOTONOHOUSE"，曲目写 "KOTONOHOUSE & Neko Hacker"），
 * 此时用曲目艺术家更准确。
 */
const ALBUM_ARTIST = `COALESCE(
  (SELECT CASE
     WHEN COUNT(DISTINCT TRIM(COALESCE(t2.artist, ''))) = 1
      AND TRIM(COALESCE(MIN(t2.artist), '')) <> ''
      AND TRIM(COALESCE(a.album_artist, '')) <> ''
      AND instr(TRIM(MIN(t2.artist)), TRIM(a.album_artist)) > 0
      AND length(TRIM(MIN(t2.artist))) > length(TRIM(a.album_artist))
     THEN TRIM(MIN(t2.artist)) END
   FROM tracks t2 WHERE t2.album_id = a.id),
  NULLIF(TRIM(a.album_artist), ''),
  NULLIF(TRIM(MIN(t.artist)), ''),
  '${PLACEHOLDER_ARTIST}')`;
const ALBUM_ARTIST_PLAIN = `COALESCE(NULLIF(TRIM(a.album_artist), ''), '${PLACEHOLDER_ARTIST}')`;

const ALBUM_SEARCH = `(
  ${ALBUM_TITLE} LIKE ? ESCAPE '\\'
  OR COALESCE(NULLIF(TRIM(a.album_artist), ''), '') LIKE ? ESCAPE '\\'
  OR COALESCE(NULLIF(TRIM(a.circle), ''), '') LIKE ? ESCAPE '\\'
  OR COALESCE(NULLIF(TRIM(a.rj_code), ''), '') LIKE ? ESCAPE '\\'
  OR EXISTS (SELECT 1 FROM tracks ts WHERE ts.album_id = a.id AND (
       ts.title LIKE ? ESCAPE '\\' OR ts.artist LIKE ? ESCAPE '\\'
       OR ts.album LIKE ? ESCAPE '\\' OR ts.genre LIKE ? ESCAPE '\\'
       OR CAST(ts.year AS TEXT) LIKE ? ESCAPE '\\'))
  OR EXISTS (SELECT 1 FROM album_tags ats JOIN tags tgs ON tgs.id = ats.tag_id
             WHERE ats.album_id = a.id AND tgs.name LIKE ? ESCAPE '\\')
)`;
const ALBUM_SEARCH_PARAMS = 10;

export const SORT_OPTIONS = {
  'artist-asc': `${ALBUM_ARTIST_PLAIN} COLLATE NOCASE ASC, a.year ASC, ${ALBUM_TITLE} COLLATE NOCASE ASC`,
  'album-asc': `${ALBUM_TITLE} COLLATE NOCASE ASC, ${ALBUM_ARTIST_PLAIN} COLLATE NOCASE ASC`,
  'album-desc': `${ALBUM_TITLE} COLLATE NOCASE DESC`,
  'year-desc': `a.year DESC NULLS LAST, ${ALBUM_TITLE} COLLATE NOCASE ASC`,
  'year-asc': `a.year ASC NULLS LAST, ${ALBUM_TITLE} COLLATE NOCASE ASC`,
  'added-desc': 'added_max DESC',
  'tracks-desc': 'track_count DESC, album COLLATE NOCASE ASC',
  'duration-desc': 'duration_sum DESC',
  'tags-desc': 'tag_count DESC, album COLLATE NOCASE ASC',
  'completeness-desc': 'track_issues DESC, album COLLATE NOCASE ASC',
};

function likeParam(q) {
  return `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function tagFilterClause(tagIds, mode) {
  const ids = (tagIds ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return { sql: '', params: [] };
  const placeholders = ids.map(() => '?').join(', ');
  if (mode === 'or') {
    return {
      sql: `AND EXISTS (SELECT 1 FROM album_tags atf WHERE atf.album_id = a.id AND atf.tag_id IN (${placeholders}))`,
      params: ids,
    };
  }
  return {
    sql: `AND (SELECT COUNT(DISTINCT atf.tag_id) FROM album_tags atf
               WHERE atf.album_id = a.id AND atf.tag_id IN (${placeholders})) = ?`,
    params: [...ids, ids.length],
  };
}

/**
 * 专辑列表。支持关键词、标签（AND/OR）、音乐库、完整性状态、排序与分页。
 */
export function listAlbums({
  q = '', sort = 'artist-asc', limit = 300, offset = 0,
  tagIds = null, tagMode = 'and', libraryId = null, status = null, favoriteOnly = false,
  kind = null,
} = {}) {
  const order = SORT_OPTIONS[sort] ?? SORT_OPTIONS['artist-asc'];
  const params = [];
  const where = [];

  if (favoriteOnly) where.push('a.favorite = 1');
  if (kind === 'voice') where.push("a.kind = 'voice'");
  else if (kind === 'music') where.push("COALESCE(a.kind, 'music') <> 'voice'");
  if (q.trim()) {
    where.push(ALBUM_SEARCH);
    params.push(...Array(ALBUM_SEARCH_PARAMS).fill(likeParam(q.trim())));
  }
  const tagFilter = tagFilterClause(tagIds, tagMode);
  if (tagFilter.sql) {
    where.push(tagFilter.sql.replace(/^AND /, ''));
    params.push(...tagFilter.params);
  }
  if (libraryId) {
    where.push('EXISTS (SELECT 1 FROM tracks tl WHERE tl.album_id = a.id AND tl.library_id = ?)');
    params.push(Number(libraryId));
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const sql = `
    SELECT a.id,
           a.album_key,
           ${ALBUM_TITLE}  AS album,
           ${ALBUM_ARTIST} AS album_artist,
           a.year, a.genre, a.is_compilation,
           a.cover_hash, a.cover_mime, a.cover_source,
           a.kind, a.rj_code, a.has_bonus, a.has_video, a.circle, a.favorite, a.favorite_at,
           (SELECT COUNT(*) FROM album_versions av WHERE av.album_id = a.id
             AND av.group_kind = 'main')        AS version_count,
           (SELECT COUNT(*) FROM tracks tv WHERE tv.album_id = a.id
             AND tv.file_kind = 'video')        AS video_count,
           COUNT(t.id)                        AS track_count,
           COALESCE(SUM(t.duration), 0)       AS duration_sum,
           MAX(t.has_cover)                   AS has_cover,
           MAX(t.added_at)                    AS added_max,
           COUNT(DISTINCT t.disc_no)          AS disc_count,
           (SELECT COUNT(*) FROM album_tags at2 WHERE at2.album_id = a.id) AS tag_count,
           -- 压缩包只读挂载（P1）：该发行有多少曲目仍在包内，供专辑墙角标使用
           (SELECT COUNT(DISTINCT ta.archive_id) FROM tracks ta
             WHERE ta.album_id = a.id AND ta.source_kind = 'archive_member') AS archive_count,
           (SELECT COUNT(*) FROM tracks ta2
             WHERE ta2.album_id = a.id AND ta2.source_kind = 'archive_member'
               AND ta2.materialized_state <> 'ready')                        AS archived_track_count,
           (SELECT COUNT(*) FROM tracks tl2 LEFT JOIN albums al2 ON al2.id = tl2.album_id
             WHERE tl2.album_id = a.id AND (
               tl2.parse_error IS NOT NULL
               OR tl2.artist IS NULL OR TRIM(tl2.artist) = '')) AS track_issues
    FROM albums a
    LEFT JOIN tracks t ON t.album_id = a.id
    ${whereSql}
    GROUP BY a.id
    ORDER BY ${order}
    LIMIT ? OFFSET ?
  `;
  const rows = db.prepare(sql).all(...params, Number(limit), Number(offset));
  const decorated = rows.map((row) => ({
    ...row,
    is_compilation: Boolean(row.is_compilation),
    is_voice: row.kind === 'voice',
    has_bonus: Boolean(row.has_bonus),
    has_video: Boolean(row.has_video),
    favorite: Boolean(row.favorite),
    cover_url: row.cover_hash ? `/api/cover/${row.cover_hash}` : null,
    library_id: libraryId ?? null,
    /** 压缩包挂载信息（P1）：包数 + 仍在包内的曲目数 */
    archive: {
      archives: Number(row.archive_count ?? 0),
      tracks: Number(row.archived_track_count ?? 0),
    },
  }));

  return filterByStatus(decorated, status);
}

function filterByStatus(albums, status) {
  if (!status) return albums;
  return albums.filter((a) => {
    const critical = !a.album || a.album === PLACEHOLDER_ALBUM || a.track_issues > 0;
    if (status === 'critical') return critical;
    if (status === 'complete') return !critical && a.cover_hash && a.year && a.tag_count > 0 && a.genre;
    return true;
  });
}

export function countAlbumsFiltered({
  q = '', tagIds = null, tagMode = 'and', libraryId = null, favoriteOnly = false, kind = null,
} = {}) {
  const params = [];
  const where = [];
  if (favoriteOnly) where.push('a.favorite = 1');
  if (kind === 'voice') where.push("a.kind = 'voice'");
  else if (kind === 'music') where.push("COALESCE(a.kind, 'music') <> 'voice'");
  if (q.trim()) {
    where.push(ALBUM_SEARCH);
    params.push(...Array(ALBUM_SEARCH_PARAMS).fill(likeParam(q.trim())));
  }
  const tagFilter = tagFilterClause(tagIds, tagMode);
  if (tagFilter.sql) {
    where.push(tagFilter.sql.replace(/^AND /, ''));
    params.push(...tagFilter.params);
  }
  if (libraryId) {
    where.push('EXISTS (SELECT 1 FROM tracks tl WHERE tl.album_id = a.id AND tl.library_id = ?)');
    params.push(Number(libraryId));
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT a.id FROM albums a LEFT JOIN tracks t ON t.album_id = a.id ${whereSql} GROUP BY a.id
    )
  `).get(...params).n;
}

export function listAlbumTracks(albumId) {
  return db.prepare(`
    SELECT t.id, t.path, t.dir, t.filename, t.ext, t.title, t.artist, t.album_artist, t.album,
           t.track_no, t.disc_no, t.year, t.genre, t.composer, t.duration, t.bitrate,
           t.sample_rate, t.channels, t.codec, t.size, t.mtime, t.library_id, t.has_cover,
           t.parse_error, t.title_source, t.meta_source, t.lyrics_path, t.favorite,
           a.circle AS album_circle, a.kind AS album_kind
    FROM tracks t LEFT JOIN albums a ON a.id = t.album_id
    WHERE t.album_id = ?
    ORDER BY COALESCE(t.disc_no, 1), COALESCE(t.track_no, 9999), t.filename COLLATE NOCASE
  `).all(Number(albumId));
}

/**
 * 「全部曲目」列表。
 * 只收录**普通音乐专辑**的曲目（kind != 'voice'）——音声发行的曲目属于三层模型，
 * 在专辑详情里按「版本 + 轨号」呈现，不进入这个平铺列表。
 */
export function listLooseTracks({
  q = '', limit = 200, offset = 0, libraryId = null, includeVoice = false,
  favoriteOnly = false,
} = {}) {
  const params = [];
  const where = [];
  if (!includeVoice) {
    where.push("COALESCE(a.kind, 'music') <> 'voice'");
  }
  if (favoriteOnly) where.push('t.favorite = 1');
  if (q.trim()) {
    const like = likeParam(q.trim());
    where.push(`(t.title LIKE ? ESCAPE '\\' OR t.artist LIKE ? ESCAPE '\\'
                 OR t.album LIKE ? ESCAPE '\\' OR t.album_artist LIKE ? ESCAPE '\\'
                 OR EXISTS (SELECT 1 FROM album_tags at3 JOIN tags tg3 ON tg3.id = at3.tag_id
                            WHERE at3.album_id = t.album_id AND tg3.name LIKE ? ESCAPE '\\'))`);
    params.push(like, like, like, like, like);
  }
  if (libraryId) {
    where.push('t.library_id = ?');
    params.push(Number(libraryId));
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`
    SELECT t.id, t.path, t.filename, t.title, t.artist, t.album, t.album_id,
           t.track_no, t.disc_no, t.year, t.duration, t.bitrate, t.sample_rate, t.codec,
           t.lyrics_path, t.meta_source, t.title_source, t.parse_error, t.favorite,
           -- 压缩包状态（P1）：供跨专辑曲目列表标注「包内」
           t.source_kind, t.materialized_state, t.archive_id, t.member_path,
           COALESCE(NULLIF(TRIM(a.title), ''), '${PLACEHOLDER_ALBUM}') AS album_title,
           a.cover_hash, a.kind AS album_kind, a.circle AS album_circle
    FROM tracks t LEFT JOIN albums a ON a.id = t.album_id
    ${whereSql}
    ORDER BY COALESCE(NULLIF(TRIM(a.album_artist), ''), t.artist) COLLATE NOCASE,
             COALESCE(NULLIF(TRIM(a.title), ''), t.album) COLLATE NOCASE,
             COALESCE(t.disc_no, 1), COALESCE(t.track_no, 9999)
    LIMIT ? OFFSET ?
  `).all(...params, Number(limit), Number(offset));
}

/** 与 listLooseTracks 同口径的总数 */
export function countLooseTracks({
  q = '', libraryId = null, includeVoice = false, favoriteOnly = false,
} = {}) {
  const params = [];
  const where = [];
  if (!includeVoice) where.push("COALESCE(a.kind, 'music') <> 'voice'");
  if (favoriteOnly) where.push('t.favorite = 1');
  if (q.trim()) {
    const like = likeParam(q.trim());
    where.push(`(t.title LIKE ? ESCAPE '\\' OR t.artist LIKE ? ESCAPE '\\'
                 OR t.album LIKE ? ESCAPE '\\' OR t.album_artist LIKE ? ESCAPE '\\'
                 OR EXISTS (SELECT 1 FROM album_tags at3 JOIN tags tg3 ON tg3.id = at3.tag_id
                            WHERE at3.album_id = t.album_id AND tg3.name LIKE ? ESCAPE '\\'))`);
    params.push(like, like, like, like, like);
  }
  if (libraryId) {
    where.push('t.library_id = ?');
    params.push(Number(libraryId));
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`
    SELECT COUNT(*) AS n FROM tracks t LEFT JOIN albums a ON a.id = t.album_id ${whereSql}
  `).get(...params).n;
}

export function getStats() {
  const base = db.prepare(`
    SELECT (SELECT COUNT(*) FROM tracks)                        AS tracks,
           (SELECT COUNT(*) FROM albums)                        AS albums,
           (SELECT COUNT(DISTINCT COALESCE(NULLIF(TRIM(album_artist), ''), NULLIF(TRIM(artist), '')))
              FROM tracks)                                      AS artists,
           (SELECT COALESCE(SUM(duration), 0) FROM tracks)      AS total_duration,
           (SELECT COALESCE(SUM(size), 0) FROM tracks)          AS total_size,
           (SELECT COUNT(*) FROM tracks WHERE parse_error IS NOT NULL) AS parse_errors,
           (SELECT COUNT(*) FROM tracks WHERE has_cover = 1)    AS with_cover,
           (SELECT COUNT(*) FROM tags)                          AS tags,
           (SELECT COUNT(*) FROM album_tags)                    AS tag_links
  `).get();

  const byFormat = db.prepare(`
    SELECT COALESCE(NULLIF(UPPER(REPLACE(ext, '.', '')), ''), '?') AS format,
           COUNT(*) AS n, COALESCE(SUM(size), 0) AS size
    FROM tracks GROUP BY format ORDER BY n DESC
  `).all();

  const byDecade = db.prepare(`
    SELECT (year / 10) * 10 AS decade, COUNT(*) AS albums
    FROM albums WHERE year IS NOT NULL AND year > 1900
    GROUP BY decade ORDER BY decade
  `).all();

  const topArtists = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(album_artist), ''), '${PLACEHOLDER_ARTIST}') AS artist,
           COUNT(*) AS albums,
           (SELECT COUNT(*) FROM tracks t WHERE t.album_id IN
              (SELECT id FROM albums a2 WHERE COALESCE(NULLIF(TRIM(a2.album_artist), ''), '${PLACEHOLDER_ARTIST}') = COALESCE(NULLIF(TRIM(albums.album_artist), ''), '${PLACEHOLDER_ARTIST}'))) AS tracks
    FROM albums GROUP BY artist ORDER BY albums DESC LIMIT 12
  `).all();

  const topTags = db.prepare(`
    SELECT tg.id, tg.name, tg.color, COUNT(at.album_id) AS albums
    FROM tags tg LEFT JOIN album_tags at ON at.tag_id = tg.id
    GROUP BY tg.id ORDER BY albums DESC, tg.name COLLATE NOCASE LIMIT 15
  `).all();

  return { ...base, archives: archiveStats(), byFormat, byDecade, topArtists, topTags };
}

export function vacuum() {
  db.exec('VACUUM');
}

export function closeDb() {
  try { db.close(); } catch { /* ignore */ }
}
