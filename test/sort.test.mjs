/**
 * 专辑墙排序（v1.2.9 新增键）：收藏时间 / 最近更新 / RJ 号。
 * 用独立临时库，不触碰用户数据；时间戳直接写死，避免依赖 now() 的毫秒竞争。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-sort-'));
process.env.LAM_DATA_DIR = dataDir;

let store;
let tags;

before(async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  store = await import('../server/db.mjs');
  tags = await import('../server/tags.mjs');
  const insert = store.db.prepare(`
    INSERT INTO albums (album_key, title, album_artist, year, is_compilation,
                        created_at, updated_at, kind, rj_code, favorite, favorite_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`);
  // 两张音声（RJ 倒序创建，确保排序不依赖插入顺序）+ 一张普通专辑（无 RJ）
  insert.run('voice\u0001rj2', 'RJ00000002 作品', '社团B', 2020, 1000, 3000, 'voice', 'RJ00000002', 1, 100);
  insert.run('voice\u0001rj1', 'RJ00000001 作品', '社团A', 2021, 1000, 2000, 'voice', 'RJ00000001', 1, 300);
  insert.run('music\u0001plain', '普通专辑', '某歌手', 2019, 1000, 1000, 'music', null, 0, null);
});

test('收藏时间：最近收藏的排最前，未收藏的排最后', () => {
  const rows = store.listAlbums({ sort: 'favorite-desc' });
  assert.deepEqual(rows.map((r) => r.album), ['RJ00000001 作品', 'RJ00000002 作品', '普通专辑']);
});

test('最近更新：按 albums.updated_at 倒序', () => {
  const rows = store.listAlbums({ sort: 'updated-desc' });
  assert.deepEqual(rows.map((r) => r.album), ['RJ00000002 作品', 'RJ00000001 作品', '普通专辑']);
});

test('RJ 号：按编号升序，没有 RJ 的排最后', () => {
  const rows = store.listAlbums({ sort: 'rj-asc' });
  assert.deepEqual(rows.map((r) => r.album), ['RJ00000001 作品', 'RJ00000002 作品', '普通专辑']);
  // 排序键在 SQL 里只影响顺序，不应该改变返回字段
  assert.equal(rows[0].rj_code, 'RJ00000001');
});

test('RJ 号：按编号降序，没有 RJ 的仍排最后', () => {
  const rows = store.listAlbums({ sort: 'rj-desc' });
  assert.deepEqual(rows.map((r) => r.album), ['RJ00000002 作品', 'RJ00000001 作品', '普通专辑']);
});

test('未知排序键回退到默认（艺术家 A→Z）', () => {
  const rows = store.listAlbums({ sort: 'not-a-sort' });
  assert.deepEqual(rows.map((r) => r.album_artist), ['某歌手', '社团A', '社团B']);
});

test('打标签算一次更新：最近更新排序把刚打标的专辑顶到前面', () => {
  const plain = store.listAlbums({ sort: 'album-asc' }).find((r) => r.album === '普通专辑');
  assert.ok(plain, '前置条件：普通专辑存在');
  tags.applyAlbumTags([plain.id], { add: ['测试标签'] });
  const rows = store.listAlbums({ sort: 'updated-desc' });
  assert.equal(rows[0].id, plain.id, '刚打过标签的专辑应排第一');
});
