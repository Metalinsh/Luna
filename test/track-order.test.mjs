/**
 * 专辑自定义播放顺序（v13）：applySavedOrder 的排序规则 + track_order 存取。
 * 独立临时库，不触碰用户数据。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-order-'));
process.env.LAM_DATA_DIR = dataDir;

let store;
let albumId;

before(async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  store = await import('../server/db.mjs');
  const info = store.db.prepare(`
    INSERT INTO albums (album_key, title, created_at, updated_at)
    VALUES ('test\u0001order', '排序测试专辑', 1000, 1000)`).run();
  albumId = Number(info.lastInsertRowid);
});

test('applySavedOrder：按给定顺序排，未列出的保持自然顺序排后面', () => {
  const rows = ['a', 'b', 'c', 'd'].map((k) => ({ key: k }));
  const out = store.applySavedOrder(rows, ['c', 'a'], (r) => r.key).map((r) => r.key);
  assert.deepEqual(out, ['c', 'a', 'b', 'd']);
});

test('applySavedOrder：order 里的无关键被忽略，空 order 不动原数组', () => {
  const rows = ['a', 'b'].map((k) => ({ key: k }));
  assert.deepEqual(
    store.applySavedOrder(rows, ['ghost', 'b'], (r) => r.key).map((r) => r.key),
    ['b', 'a'],
  );
  assert.equal(store.applySavedOrder(rows, [], (r) => r.key), rows, '空顺序应原样返回');
});

test('applySavedOrder：数字键与字符串键等价（普通专辑用 track id）', () => {
  const rows = [{ id: 1 }, { id: 2 }];
  const out = store.applySavedOrder(rows, ['2', '1'], (r) => String(r.id));
  assert.deepEqual(out.map((r) => r.id), [2, 1]);
});

test('track_order：保存 / 读取 / 去重 / 清空', () => {
  assert.deepEqual(store.getAlbumTrackOrder(albumId), []);
  const saved = store.setAlbumTrackOrder(albumId, ['b', 'a', 'b', '']);
  assert.deepEqual(saved, ['b', 'a']);
  assert.deepEqual(store.getAlbumTrackOrder(albumId), ['b', 'a']);
  store.setAlbumTrackOrder(albumId, []);
  assert.deepEqual(store.getAlbumTrackOrder(albumId), []);
});

test('track_order：坏数据当作没有自定义顺序，不抛错', () => {
  store.db.prepare('UPDATE albums SET track_order = ? WHERE id = ?').run('{not-json', albumId);
  assert.deepEqual(store.getAlbumTrackOrder(albumId), []);
  store.db.prepare('UPDATE albums SET track_order = ? WHERE id = ?').run('{"a":1}', albumId);
  assert.deepEqual(store.getAlbumTrackOrder(albumId), []);
});
