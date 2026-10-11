/**
 * 专辑图片画廊测试（专辑详情页「图片预览」栏目）。
 *
 * 磁盘部分用合成目录树，不依赖用户的真实文件；
 * 若真机存在 E:\Music\ASMR 下的压缩包，末尾追加一组**只读**回归断言
 * （沿用了 zip-reader.test.mjs 的做法）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-gallery-'));
process.env.LAM_DATA_DIR = dataDir;

let store;
let gallery;
let zip;
let asmr;

before(async () => {
  store = await import('../server/db.mjs');
  gallery = await import('../server/gallery.mjs');
  zip = await import('../server/zip-reader.mjs');
  asmr = await import('../server/asmr.mjs');
});

let sandbox;
let seq = 0;
before(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-gallery-files-')); });
after(() => {
  for (const dir of [sandbox, dataDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

/** 造目录树：{ '相对路径': 字符串内容 } → 返回发行根 */
function makeTree(spec) {
  seq += 1;
  const root = path.join(sandbox, `release-${seq}`);
  for (const [rel, content] of Object.entries(spec)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content ?? 'x');
  }
  return root;
}

/* ------------------------------------------------------------------ 磁盘 */

test('磁盘：按图片所在文件夹分组', () => {
  const root = makeTree({
    'cover.jpg': 'a',
    '01.音声.wav': 'a',
    '特典/画像/01.png': 'bbb',
    '特典/画像/02.png': 'b',
    'EXデータ/パッケージ.jpg': 'cc',
    'readme.txt': 'a',
  });

  const g = gallery.listAlbumImages({ id: 1, release_root: root }, []);
  assert.equal(g.source, 'disk');
  assert.equal(g.images.length, 4, '应列出 4 张图片');
  assert.ok(g.images.every((i) => gallery.isImageName(i.name)), '清单里只能有图片');

  const labels = g.groups.map((x) => x.label);
  assert.equal(labels[0], '根目录', '根目录一组应排在最前');
  assert.deepEqual([...labels].sort(), ['EXデータ', '特典/画像', '根目录'].sort(),
    `分组名称不符：${labels.join(' | ')}`);

  const bonus = g.groups.find((x) => x.label === '特典/画像');
  assert.deepEqual(bonus.indices.map((i) => g.images[i].name), ['01.png', '02.png'], '组内应按文件名自然序');
  for (const img of g.images) {
    assert.match(img.url, /^\/api\/albums\/1\/image\?p=/);
  }
});

test('磁盘：普通音乐专辑用曲目所在目录', () => {
  const root = makeTree({ 'cover.png': 'a', '01.歌.mp3': 'a' });
  const tracks = [{ dir: root }, { dir: root }];
  const g = gallery.listAlbumImages({ id: 2, release_root: null }, tracks);
  assert.equal(g.images.length, 1);
  assert.equal(g.images[0].name, 'cover.png');
});

test('磁盘：递归深度与隐藏目录都不越界', () => {
  const root = makeTree({
    'a/b/c/d/e/deep.png': 'x',
    '.hidden/secret.png': 'x',
    'top.jpg': 'x',
  });
  const g = gallery.listAlbumImages({ id: 3, release_root: root }, []);
  const names = g.images.map((i) => i.name);
  assert.ok(names.includes('top.jpg'));
  assert.ok(!names.includes('secret.png'), '隐藏目录不收录');
  assert.ok(!names.includes('deep.png'), '超过深度上限不收录');
});

test('磁盘：取原图成功，且命中文件夹内文件', async () => {
  const root = makeTree({ '画像/a.png': 'hello' });
  const album = { id: 4, release_root: root };
  const got = await gallery.resolveAlbumImage(album, [], path.join(root, '画像', 'a.png'));
  assert.ok(got?.filePath, '应返回可发送的文件路径');
  assert.equal(got.mime, 'image/png');
});

test('磁盘：专辑目录之外的文件一律拒绝（路径穿越）', async () => {
  const root = makeTree({ 'cover.jpg': 'x' });
  const outside = path.join(sandbox, 'outside.jpg');
  fs.writeFileSync(outside, 'x');

  assert.equal(await gallery.resolveAlbumImage({ id: 5, release_root: root }, [], outside), null,
    '同盘但不在专辑目录内的图片必须拒绝');
  assert.equal(await gallery.resolveAlbumImage({ id: 5, release_root: root }, [], path.join(root, '..', 'outside.jpg')), null);
  assert.equal(await gallery.resolveAlbumImage({ id: 5, release_root: root }, [], path.join(root, '不存在的.jpg')), null);
});

test('磁盘：非图片扩展名一律拒绝', async () => {
  const root = makeTree({ 'readme.txt': 'x', 'cover.jpg': 'x' });
  assert.equal(await gallery.resolveAlbumImage({ id: 6, release_root: root }, [], path.join(root, 'readme.txt')), null);
  assert.equal(await gallery.resolveAlbumImage({ id: 6, release_root: root }, [], ''), null);
  assert.equal(await gallery.resolveAlbumImage({ id: 6, release_root: root }, [], null), null);
});

/* --------------------------------------------------- 压缩包（真机样本，只读） */

const REAL_DIR = 'E:\\Music\\ASMR';

function realZips() {
  try {
    return fs.readdirSync(REAL_DIR)
      .filter((f) => f.toLowerCase().endsWith('.zip'))
      .map((f) => path.join(REAL_DIR, f));
  } catch { return []; }
}

test('压缩包：图片进画廊、不进轨道（真机样本，只读）', async (t) => {
  const zips = realZips();
  if (!zips.length) return t.skip('本机没有 E:\\Music\\ASMR 下的压缩包样本');

  for (const zipPath of zips) {
    const info = await zip.probeZip(zipPath);
    const imageEntries = info.entries.filter((e) => e.kind === 'image');
    if (!imageEntries.length) continue;

    const before = { size: fs.statSync(zipPath).size, mtime: fs.statSync(zipPath).mtimeMs };

    // 登记进临时库后，画廊应只从 archive_members 里读图片
    const archiveId = store.upsertArchive({
      path: zipPath, format: 'zip', entryCount: info.entries.length,
      imageCount: imageEntries.length,
    }, info.entries);
    assert.ok(archiveId > 0);

    const album = { id: 99, release_root: zipPath };
    const g = gallery.listAlbumImages(album, []);
    assert.equal(g.source, 'archive');
    assert.equal(g.images.length, imageEntries.length,
      `${path.basename(zipPath)}：画廊张数应等于包内图片数`);
    assert.ok(g.images.every((i) => gallery.isImageName(i.name)));

    // 原图可取回，且字节数与中央目录一致
    const first = g.images[0];
    const got = await gallery.resolveAlbumImage(album, [], first.key);
    assert.ok(got?.data, '压缩包内图片应能解出');
    assert.equal(got.data.length, first.size, '解出字节数应与清单一致');

    // 包内图片不得进入轨道模型
    const files = info.entries.filter((e) => e.kind !== 'dir').map((e) => ({
      path: zip.virtualPath(zipPath, e.name),
      name: path.posix.basename(e.name),
      ext: path.posix.extname(e.name).toLowerCase(),
      kind: e.kind,
      size: e.size,
    }));
    const analysis = await asmr.analyzeRelease(zipPath, { readTags: false, files });
    for (const row of [...analysis.tracks, ...analysis.bonusTracks]) {
      for (const v of row.versions) {
        assert.ok(['audio', 'video'].includes(v.file.kind),
          `${path.basename(zipPath)}：轨道里混进了 ${v.file.kind}（${v.file.name}）`);
      }
    }

    // 只读：源包不得被改动
    const after = fs.statSync(zipPath);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtime);
  }
});

test('压缩包：穿越与不存在的成员都拒绝（真机样本，只读）', async (t) => {
  const zips = realZips();
  if (!zips.length) return t.skip('本机没有 E:\\Music\\ASMR 下的压缩包样本');

  for (const zipPath of zips) {
    const info = await zip.probeZip(zipPath);
    if (!info.entries.some((e) => e.kind === 'image')) continue;
    store.upsertArchive({ path: zipPath, format: 'zip', entryCount: info.entries.length }, info.entries);
    const album = { id: 98, release_root: zipPath };

    assert.equal(await gallery.resolveAlbumImage(album, [], '..\\..\\Windows\\win.ini'), null);
    assert.equal(await gallery.resolveAlbumImage(album, [], '不存在的图片.jpg'), null);
    // 音频成员也不能当图片取出来
    const audio = info.entries.find((e) => e.kind === 'audio');
    if (audio) assert.equal(await gallery.resolveAlbumImage(album, [], audio.name), null);
  }
});
