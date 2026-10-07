/**
 * 封面回收测试（设计文档 D1）：孤儿封面必须被回收，仍被引用的必须保留。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-gc-'));
process.env.LAM_DATA_DIR = dataDir;

let store;
let maintenance;

before(async () => {
  store = await import('../server/db.mjs');
  maintenance = await import('../server/maintenance.mjs');
});

function seedAlbumWithCover(hash, file) {
  const resolved = store.resolveAlbumForTrack({ album: `专辑-${hash}`, artist: 'G', dir: 'E:\\M' });
  store.upsertTrack({
    path: `E:\\M\\${hash}.flac`, dir: 'E:\\M', filename: `${hash}.flac`, ext: '.flac',
    title: 'T', artist: 'G', albumArtist: 'G', album: `专辑-${hash}`,
    albumKey: resolved.albumKey, albumId: resolved.albumId, hasCover: false,
  });
  store.applyCover(resolved.albumId, { hash, file, mime: 'image/jpeg', source: 'embedded' });
  return resolved.albumId;
}

test('封面回收：孤儿文件被删除，被引用的保留', () => {
  const coverDir = path.join(dataDir, 'covers');
  fs.mkdirSync(coverDir, { recursive: true });

  // 两个被引用的封面
  fs.writeFileSync(path.join(coverDir, 'used-a.jpg'), Buffer.alloc(1200));
  fs.writeFileSync(path.join(coverDir, 'used-b.jpg'), Buffer.alloc(800));
  seedAlbumWithCover('used-a', 'used-a.jpg');
  seedAlbumWithCover('used-b', 'used-b.jpg');

  // 三个孤儿文件
  fs.writeFileSync(path.join(coverDir, 'orphan-1.jpg'), Buffer.alloc(500));
  fs.writeFileSync(path.join(coverDir, 'orphan-2.jpg'), Buffer.alloc(700));
  fs.writeFileSync(path.join(coverDir, 'orphan-3.png'), Buffer.alloc(300));

  const dry = maintenance.collectOrphanCovers({ dryRun: true });
  assert.equal(dry.files, 3, 'dryRun 应报告 3 个孤儿文件');
  assert.equal(dry.bytes, 1500);
  assert.equal(fs.existsSync(path.join(coverDir, 'orphan-1.jpg')), true, 'dryRun 不删除文件');

  const result = maintenance.collectOrphanCovers();
  assert.equal(result.files, 3, '实际回收 3 个');
  assert.equal(result.kept, 2, '保留 2 个被引用的封面');
  assert.equal(fs.existsSync(path.join(coverDir, 'orphan-1.jpg')), false);
  assert.equal(fs.existsSync(path.join(coverDir, 'orphan-2.jpg')), false);
  assert.equal(fs.existsSync(path.join(coverDir, 'orphan-3.png')), false);
  assert.equal(fs.existsSync(path.join(coverDir, 'used-a.jpg')), true);
  assert.equal(fs.existsSync(path.join(coverDir, 'used-b.jpg')), true);
});

test('封面回收：缩略图缓存整目录可回收', () => {
  const thumbDir = path.join(dataDir, 'covers', 'thumbs');
  fs.mkdirSync(thumbDir, { recursive: true });
  fs.writeFileSync(path.join(thumbDir, 'used-a-512.img'), Buffer.alloc(64));

  const result = maintenance.collectOrphanCovers();
  assert.equal(result.files, 1, '缩略图被回收');
  assert.equal(fs.existsSync(path.join(thumbDir, 'used-a-512.img')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'covers', 'used-a.jpg')), true, '原图仍保留');
});

test('封面占用统计', () => {
  const usage = maintenance.coverStorageUsage();
  assert.equal(usage.files, 2);
  assert.equal(usage.bytes, 2000);
});

test('移除专辑后其封面变为孤儿并可被回收', () => {
  const coverDir = path.join(dataDir, 'covers');
  fs.writeFileSync(path.join(coverDir, 'used-b-tmp.jpg'), Buffer.alloc(256));
  const albumId = seedAlbumWithCover('used-b-tmp', 'used-b-tmp.jpg');
  assert.equal(fs.existsSync(path.join(coverDir, 'used-b-tmp.jpg')), true);

  // 删掉该专辑的唯一曲目 → 专辑被清理 → 封面失去引用
  const track = store.db.prepare('SELECT path FROM tracks WHERE album_id = ?').get(albumId);
  store.deleteTrackByPath(track.path);

  const result = maintenance.collectOrphanCovers();
  assert.ok(result.files >= 1);
  assert.equal(fs.existsSync(path.join(coverDir, 'used-b-tmp.jpg')), false, '失去引用的封面已回收');
});
