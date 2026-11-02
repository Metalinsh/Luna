/**
 * ASMR 库的**整库音声化**（v1.2.6）。
 *
 * 用户实测：丢进 ASMR 库、但文件名/目录名里没有 RJ 号的作品，虽然挂了「ASMR」标签，
 * 详情页却是普通专辑样式、压缩包也按普通专辑解析。
 *
 * 规则（本次修正）：**库目录名含 ASMR → 其中所有内容都进音声三层模型**，
 * 不再要求 RJ 号；没有 RJ 时按「库下的一级目录」定发行根，直接躺在库根的文件
 * 只按该层清单入库。非 ASMR 库维持「有 RJ 才走音声」。
 *
 * 端到端跑的是真实扫描流程（临时数据目录 + 临时音乐库），压缩包用合成 ZIP。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-voice-lib-'));
const dataDir = path.join(root, 'data');
const asmrLib = path.join(root, 'Music', 'ASMR');
const musicLib = path.join(root, 'Music', 'Album');
fs.mkdirSync(asmrLib, { recursive: true });
fs.mkdirSync(musicLib, { recursive: true });

/* --------------------------------------------------------------- 造测试素材 */

/** 造一个合法 ZIP（stored 头 + deflate 数据，足够 zip-reader 解析清单） */
function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    const name = Buffer.from(e.name, 'utf8');
    const packed = zlib.deflateRawSync(raw);
    const crc = typeof zlib.crc32 === 'function' ? zlib.crc32(raw) : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x5a21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, packed);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x5a21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);

    offset += local.length + name.length + packed.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, eocd]);
}

/** 假音频：读不出标签也没关系，扫描会按文件名兜底 */
const fakeAudio = (n) => Buffer.from(`not-a-real-audio-${n}`.repeat(20), 'utf8');

// ① ASMR 库：无 RJ 的目录型作品（含「特典」子目录，用于验证三层模型）
const plainDir = path.join(asmrLib, '无RJ作品A');
fs.mkdirSync(path.join(plainDir, '特典'), { recursive: true });
fs.writeFileSync(path.join(plainDir, '01 开篇.mp3'), fakeAudio(1));
fs.writeFileSync(path.join(plainDir, '02 正篇.mp3'), fakeAudio(2));
fs.writeFileSync(path.join(plainDir, '特典', '特典音轨.mp3'), fakeAudio(3));

// ② ASMR 库：无 RJ 的压缩包（用户实测的那一类）
const zipPath = path.join(asmrLib, '[Comiket 91][かの仔] かのコレクション.zip');
fs.writeFileSync(zipPath, makeZip([
  { name: '01.mp3', data: fakeAudio(4) },
  { name: '02.mp3', data: fakeAudio(5) },
]));

// ③ 普通库：同样无 RJ，必须保持普通专辑（不能因为这次修改被误判成音声）
const musicDir = path.join(musicLib, '普通专辑B');
fs.mkdirSync(musicDir, { recursive: true });
fs.writeFileSync(path.join(musicDir, 'track1.mp3'), fakeAudio(6));

process.env.LAM_DATA_DIR = dataDir;
const store = await import('../server/db.mjs');
const scanner = await import('../server/scanner.mjs');

store.addLibrary(asmrLib);
store.addLibrary(musicLib);

async function scan() {
  const r = scanner.startScan({});
  assert.equal(r.started, true, '扫描应当启动成功');
  await scanner.waitForScan();
}

const albumOf = (releaseRoot) => store.findVoiceAlbum(releaseRoot);

/** 直接查 tracks（listAlbumTracks 不带 source_kind / is_bonus 等列） */
const trackRows = (albumId) => store.db
  .prepare('SELECT id, source_kind, archive_id, is_bonus FROM tracks WHERE album_id = ? ORDER BY id')
  .all(albumId);

/* --------------------------------------------------------------------- 用例 */

test('ASMR 库：无 RJ 的目录作品按音声三层模型入库', async () => {
  await scan();

  const album = albumOf(plainDir);
  assert.ok(album, '应建立音声发行（而不是普通专辑）');
  assert.equal(album.kind, 'voice');
  assert.equal(album.is_voice, true);
  assert.equal(album.rj_code, null, '没有 RJ 号，不应凭空编一个');
  assert.equal(album.has_bonus, true, '「特典」子目录应识别为特典分组');

  const rows = trackRows(album.id);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((t) => t.source_kind === 'file'));
  assert.ok(rows.some((t) => t.is_bonus === 1), '特典音轨应标记为 bonus');
  // 版本层也应建立：正文与特典各自分组
  const versions = store.listAlbumVersions(album.id);
  assert.ok(versions.length >= 2, `版本数应 ≥2，实际 ${versions.length}`);
});

test('ASMR 库：无 RJ 的压缩包按音声发行挂载（不再解析成普通专辑）', async () => {
  const album = albumOf(zipPath);
  assert.ok(album, '压缩包应建立音声发行');
  assert.equal(album.kind, 'voice');
  assert.equal(album.rj_code, null);

  const rows = trackRows(album.id);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((t) => t.source_kind === 'archive_member'), '包内曲目应为归档态');
  assert.ok(rows.every((t) => t.archive_id), '包内曲目应带 archive_id');
});

test('两个 ASMR 发行都会被自动打上 ASMR 标签', () => {
  for (const releaseRoot of [plainDir, zipPath]) {
    const album = albumOf(releaseRoot);
    const tags = store.db.prepare(`
      SELECT t.name FROM album_tags at JOIN tags t ON t.id = at.tag_id WHERE at.album_id = ?
    `).all(album.id).map((r) => r.name);
    assert.ok(tags.includes('ASMR'), `${releaseRoot} 应带 ASMR 标签，实际 ${tags.join(',')}`);
  }
});

test('普通音乐库里的无 RJ 专辑保持普通专辑', () => {
  // 普通专辑不写 release_root，按曲目路径反查归属
  const row = store.db.prepare(`
    SELECT a.id, a.kind, a.rj_code FROM tracks t JOIN albums a ON a.id = t.album_id
    WHERE t.path LIKE '%普通专辑B%'
    LIMIT 1
  `).get();
  assert.ok(row, '应存在普通专辑');
  assert.equal(row.kind, 'music');
  assert.equal(row.rj_code, null);
});

test('判定规则变了之后，已入过库的压缩包会被强制重建（不走增量跳过）', async () => {
  const album = albumOf(zipPath);
  // 模拟旧版本留下的状态：这个包被当成普通专辑入库过
  store.db.prepare("UPDATE albums SET kind = 'music' WHERE id = ?").run(album.id);
  assert.equal(store.getAlbumById(album.id).kind, 'music');

  await scan();   // 包文件没变（size + mtime 相同），但类别不对，必须重建

  const after = store.getAlbumById(album.id);
  assert.equal(after.kind, 'voice', 'ASMR 库里的包应被重新按音声模型入库');
  assert.equal(trackRows(album.id).length, 2);
});
