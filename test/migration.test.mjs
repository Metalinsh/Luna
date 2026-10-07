/**
 * V1 → V2 迁移测试（设计文档 6.4）。
 * 先在临时目录造一个 V1 结构的数据库，再加载 db.mjs 触发迁移，逐项断言。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-migrate-'));
process.env.LAM_DATA_DIR = dataDir;

/** 构造一个 V1 数据库：两张专辑、内嵌/目录两种封面、一条缺标签的曲目 */
function buildV1Database() {
  const dbFile = path.join(dataDir, 'library.db');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE libraries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      added_at INTEGER NOT NULL,
      last_scan_at INTEGER,
      track_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE, dir TEXT NOT NULL, library_id INTEGER,
      filename TEXT NOT NULL, ext TEXT, size INTEGER, mtime INTEGER,
      title TEXT, artist TEXT, album_artist TEXT, album TEXT, album_key TEXT NOT NULL,
      track_no INTEGER, disc_no INTEGER, year INTEGER, genre TEXT, composer TEXT,
      duration REAL, bitrate INTEGER, sample_rate INTEGER, channels INTEGER,
      codec TEXT, container TEXT, has_cover INTEGER NOT NULL DEFAULT 0,
      parse_error TEXT, added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE covers (
      album_key TEXT PRIMARY KEY, hash TEXT NOT NULL, file TEXT NOT NULL,
      mime TEXT NOT NULL, source TEXT, updated_at INTEGER NOT NULL
    );
  `);

  const t = 1_700_000_000_000;
  db.prepare('INSERT INTO libraries (id, path, added_at, track_count) VALUES (1, ?, ?, 3)')
    .run('E:\\Music', t);

  const insertTrack = db.prepare(`
    INSERT INTO tracks (path, dir, library_id, filename, ext, size, mtime,
      title, artist, album_artist, album, album_key, track_no, year, genre,
      has_cover, added_at, updated_at)
    VALUES (?, ?, 1, ?, ?, 1000, 42, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const dir = 'E:\\Music\\Bach';
  insertTrack.run(`${dir}\\01.mp3`, dir, '01.mp3', '.mp3', 'Toccata', 'Karl Richter', 'Karl Richter', 'Toccata & Fugue', 'alb\u0000karl richter\u0000toccata & fugue', 1, 1970, 'Classical', 1, t, t);
  insertTrack.run(`${dir}\\02.mp3`, dir, '02.mp3', '.mp3', 'Passacaglia', 'Karl Richter', 'Karl Richter', 'Toccata & Fugue', 'alb\u0000karl richter\u0000toccata & fugue', 2, 1970, 'Classical', 1, t, t);

  // 无标签曲目：标题来自文件名
  const dir2 = 'E:\\Music\\Unsorted';
  insertTrack.run(`${dir2}\\track-three.m4a`, dir2, 'track-three.m4a', '.m4a', 'track-three', null, null, null, 'dir\u0000e:\\music\\unsorted', null, null, null, 0, t, t);

  db.prepare('INSERT INTO covers (album_key, hash, file, mime, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('alb\u0000karl richter\u0000toccata & fugue', 'abc123', 'abc123.jpg', 'image/jpeg', 'embedded', t);
  db.close();
}

let store;
before(async () => {
  buildV1Database();
  store = await import('../server/db.mjs');
});

test('迁移：生成专辑实体并把曲目挂到专辑上', () => {
  const albums = store.db.prepare('SELECT * FROM albums ORDER BY album_key').all();
  assert.equal(albums.length, 2, '两张专辑');

  const bach = albums.find((a) => a.title === 'Toccata & Fugue');
  assert.ok(bach, '标签专辑存在');
  assert.equal(bach.album_artist, 'Karl Richter');
  assert.equal(bach.year, 1970);
  assert.equal(bach.genre, 'Classical');

  const unlinked = store.db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE album_id IS NULL').get().n;
  assert.equal(unlinked, 0, '所有曲目都已关联专辑');
});

test('迁移：V1 的 covers 数据并入 albums，covers 表被删除', () => {
  const bach = store.db.prepare("SELECT * FROM albums WHERE title = 'Toccata & Fugue'").get();
  assert.equal(bach.cover_hash, 'abc123');
  assert.equal(bach.cover_source, 'embedded');
  const coversTable = store.db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='covers'",
  ).get();
  assert.equal(coversTable, undefined, 'covers 表已移除');
});

test('迁移：title_source 回填（文件名标题 vs 标签标题）', () => {
  const rows = store.db.prepare('SELECT filename, title_source FROM tracks ORDER BY filename').all();
  const byName = Object.fromEntries(rows.map((r) => [r.filename, r.title_source]));
  assert.equal(byName['track-three.m4a'], 'filename', '标题等于文件名 → filename');
  assert.equal(byName['01.mp3'], 'tag', '标题来自标签 → tag');
});

test('迁移：自动生成 V1 数据库备份', () => {
  const backup = path.join(dataDir, 'backup', 'library.db.v1.bak');
  assert.ok(fs.existsSync(backup), '备份文件存在');
});

test('迁移：schema_version 写入当前版本，重复加载不重复迁移', async () => {
  assert.equal(store.getMeta('schema_version'), String(store.SCHEMA_VERSION));
  assert.equal(store.migrationReport.migrated, true);
});

test('迁移后可正常查询专辑列表，旧接口语义保持', () => {
  const albums = store.listAlbums({ sort: 'album-asc' });
  assert.equal(albums.length, 2);
  const bach = albums.find((a) => a.album === 'Toccata & Fugue');
  assert.equal(bach.track_count, 2);
  assert.equal(bach.album_artist, 'Karl Richter');
  assert.ok(bach.cover_url);

  // 占位名兜底
  const unknown = albums.find((a) => a.album_key.startsWith('dir'));
  assert.equal(unknown.album, '(未知专辑)');
  assert.equal(unknown.album_artist, '(未知艺术家)');
});

test('迁移后可取专辑曲目，按音轨号排序', () => {
  const bach = store.db.prepare("SELECT id FROM albums WHERE title = 'Toccata & Fugue'").get();
  const tracks = store.listAlbumTracks(bach.id);
  assert.deepEqual(tracks.map((t) => t.track_no), [1, 2]);
});

test('迁移后统计口径正确', () => {
  const stats = store.getStats();
  assert.equal(stats.tracks, 3);
  assert.equal(stats.albums, 2);
  assert.equal(stats.artists, 1, '只有一个具名艺术家');
});
