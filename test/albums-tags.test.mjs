/**
 * 专辑实体化（重聚合）、标签体系与完整性规则的核心行为测试。
 * 对应设计文档 6.3 / 5.5 / 5.2.3。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-albums-'));
process.env.LAM_DATA_DIR = dataDir;

let store;
let tags;
let completeness;

before(async () => {
  store = await import('../server/db.mjs');
  tags = await import('../server/tags.mjs');
  completeness = await import('../server/completeness.mjs');
});

let trackSeq = 0;

/** 造一条曲目并返回 { trackId, albumId } */
function addTrack({ album, artist = 'Radiohead', albumArtist = artist, dir = 'E:\\Music\\RH', trackNo = null, title = 'Song', year = null, genre = null, titleSource = 'tag', parseError = null }) {
  const albumKey = store.resolveAlbumForTrack({ album, artist, albumArtist, dir, year, genre });
  trackSeq += 1;
  const file = `${dir}\\t${trackSeq}.mp3`;
  store.upsertTrack({
    path: file,
    dir,
    libraryId: null,
    filename: `t${trackSeq}.mp3`,
    ext: '.mp3',
    size: 1000 + trackSeq,
    mtime: 42,
    title,
    artist,
    albumArtist,
    album,
    albumKey: albumKey.albumKey,
    albumId: albumKey.albumId,
    trackNo,
    year,
    genre,
    titleSource,
    parseError,
    hasCover: false,
  });
  const trackId = store.db.prepare('SELECT id FROM tracks WHERE path = ?').get(file).id;
  return { trackId, albumId: albumKey.albumId, action: albumKey.action };
}

function tagNamesFor(albumId) {
  return tags.getAlbumTags(albumId).map((t) => t.name).sort();
}

/* ------------------------------------------------------------ 重聚合：改名 */

test('改名：专辑实体延续（id 不变），标签与封面全部保留', () => {
  const { trackId, albumId } = addTrack({ album: 'Untitled', trackNo: 1 });
  tags.applyAlbumTags([albumId], { add: ['待整理'] });
  store.applyCover(albumId, { hash: 'hash-rename', file: 'hash-rename.jpg', mime: 'image/jpeg', source: 'embedded' });

  // 用户把专辑名改掉（模拟写回后重新解析：同一 track 记录，album 字段变化）
  const resolved = store.resolveAlbumForTrack({
    id: trackId, album: 'OK Computer', artist: 'Radiohead', albumArtist: 'Radiohead', dir: 'E:\\Music\\RH',
  });

  assert.equal(resolved.action, 'renamed', '走"改名延续"分支');
  assert.equal(resolved.albumId, albumId, '专辑 id 不变');
  const album = store.getAlbumById(albumId);
  assert.equal(album.album_key, 'alb\u0000radiohead\u0000ok computer', 'album_key 已更新');
  assert.equal(album.title, 'OK Computer');
  assert.deepEqual(tagNamesFor(albumId), ['待整理'], '标签仍在该专辑上');
  assert.equal(album.cover_hash, 'hash-rename', '封面仍在');
});

test('改名：tracks.album_key 同步为新键', () => {
  const album = store.db.prepare("SELECT id FROM albums WHERE title = 'OK Computer'").get();
  const rows = store.db.prepare('SELECT album_key FROM tracks WHERE album_id = ?').all(album.id);
  assert.ok(rows.length > 0);
  for (const r of rows) assert.equal(r.album_key, 'alb\u0000radiohead\u0000ok computer');
});

/* ------------------------------------------------------------ 重聚合：合并 */

test('合并：目标键已被占用时，两张专辑合并且标签取并集', () => {
  const a = addTrack({ album: 'Kid A', trackNo: 1 });
  const b = addTrack({ album: 'Amnesiac', trackNo: 1 });
  assert.notEqual(a.albumId, b.albumId);

  tags.applyAlbumTags([a.albumId], { add: ['电子'] });
  tags.applyAlbumTags([b.albumId], { add: ['氛围'] });

  // 把 b 的专辑名改成与 a 相同 → 触发合并
  const resolved = store.resolveAlbumForTrack({
    id: b.trackId, album: 'Kid A', artist: 'Radiohead', albumArtist: 'Radiohead', dir: 'E:\\Music\\RH',
  });

  assert.equal(resolved.action, 'merged', '走"合并"分支');
  assert.equal(resolved.albumId, a.albumId, '并入目标专辑');
  assert.equal(store.getAlbumById(b.albumId), null, '源专辑已被删除');
  assert.deepEqual(tagNamesFor(a.albumId), ['氛围', '电子'], '标签并集，一张都不丢');
  assert.equal(store.listAlbumTracks(a.albumId).length, 2, '两条曲目都在目标专辑下');
});

test('合并：目标无封面时继承源封面', () => {
  const a = addTrack({ album: 'A 专辑', trackNo: 1 });
  const b = addTrack({ album: 'B 专辑', trackNo: 1 });
  store.applyCover(b.albumId, { hash: 'hash-cover-b', file: 'hash-cover-b.jpg', mime: 'image/jpeg', source: 'folder' });

  store.resolveAlbumForTrack({
    id: b.trackId, album: 'A 专辑', artist: 'Radiohead', albumArtist: 'Radiohead', dir: 'E:\\Music\\RH',
  });
  assert.equal(store.getAlbumById(a.albumId).cover_hash, 'hash-cover-b');
});

test('合并：不同专辑之间不会互相干扰（键不同的曲目各归各的）', () => {
  const a = addTrack({ album: '专一', artist: '甲', trackNo: 1 });
  const b = addTrack({ album: '专二', artist: '乙', trackNo: 1 });
  assert.notEqual(a.albumId, b.albumId);
  assert.equal(store.listAlbumTracks(a.albumId).length, 1);
  assert.equal(store.listAlbumTracks(b.albumId).length, 1);
});

/* ------------------------------------------------------------------ 标签 */

test('标签：大小写不敏感去重，同名不会重复创建', () => {
  const first = tags.ensureTag('Rock');
  const second = tags.ensureTag('rock');
  assert.equal(first.id, second.id);
  assert.equal(tags.listTags().filter((t) => t.name.toLowerCase() === 'rock').length, 1);
});

test('标签：名称规范化与校验', () => {
  assert.equal(tags.normalizeTagName('  日系   流行 '), '日系 流行');
  assert.equal(tags.validateTagName('   ').ok, false);
  assert.equal(tags.validateTagName('x'.repeat(25)).ok, false);
  const t = tags.createTag('  纯音乐  ');
  assert.equal(t.name, '纯音乐', '首尾空格被去掉');
});

test('标签：合并把关联迁移到目标并删除源标签', () => {
  const { albumId } = addTrack({ album: '标签合并目标', trackNo: 1 });
  const src = tags.createTag('临时标签');
  const dst = tags.createTag('正式标签');
  tags.applyAlbumTags([albumId], { add: [src.id] });

  const result = tags.mergeTags(src.id, dst.id);
  assert.equal(result.moved, 1);
  assert.equal(tags.getTag(src.id), null, '源标签已删除');
  assert.deepEqual(tagNamesFor(albumId), ['正式标签']);
});

test('标签：批量打标（含按名字新建）与移除', () => {
  const a = addTrack({ album: '批量甲', trackNo: 1 });
  const b = addTrack({ album: '批量乙', trackNo: 1 });
  assert.equal(tags.findTagByName('批量摇滚'), null, '前置：标签尚不存在');

  const result = tags.applyAlbumTags([a.albumId, b.albumId], { add: ['批量摇滚', '批量纯音乐'] });
  assert.equal(result.created, 2, '两个标签都是新建的');
  assert.equal(result.added, 4, '2 专辑 × 2 标签');
  assert.deepEqual(tagNamesFor(a.albumId), ['批量摇滚', '批量纯音乐']);

  const id = tags.findTagByName('批量摇滚').id;
  tags.applyAlbumTags([a.albumId], { remove: [id] });
  assert.deepEqual(tagNamesFor(a.albumId), ['批量纯音乐']);
  assert.deepEqual(tagNamesFor(b.albumId), ['批量摇滚', '批量纯音乐'], '不影响另一张专辑');

  // 再次用同名标签打标时不应重复创建
  const again = tags.applyAlbumTags([a.albumId], { add: ['批量纯音乐'] });
  assert.equal(again.created, 0);
});

test('标签：AND 与 OR 检索语义', () => {
  const tagA = tags.ensureTag('检索甲');
  const tagB = tags.ensureTag('检索乙');

  const both = addTrack({ album: '检索双标', artist: '检索人', trackNo: 1 });
  const onlyA = addTrack({ album: '检索单标', artist: '检索人', trackNo: 1 });
  tags.applyAlbumTags([both.albumId], { add: [tagA.id, tagB.id] });
  tags.applyAlbumTags([onlyA.albumId], { add: [tagA.id] });

  const andIds = tags.albumIdsByTags([tagA.id, tagB.id], 'and');
  const orIds = tags.albumIdsByTags([tagA.id, tagB.id], 'or');

  assert.deepEqual(andIds, [both.albumId], 'AND = 同时具备两个标签');
  assert.ok(orIds.includes(both.albumId));
  assert.ok(orIds.includes(onlyA.albumId), 'OR = 任一标签');
  assert.ok(orIds.length > andIds.length);
});

test('标签：删除标签只解除关联，不影响专辑', () => {
  const { albumId } = addTrack({ album: '待删标签专辑', trackNo: 1 });
  const tag = tags.createTag('即将删除');
  tags.applyAlbumTags([albumId], { add: [tag.id] });
  const before = store.getAlbumById(albumId);
  assert.ok(before);

  tags.deleteTag(tag.id);
  assert.equal(tags.getTag(tag.id), null);
  assert.ok(store.getAlbumById(albumId), '专辑仍在');
  assert.deepEqual(tagNamesFor(albumId), []);
});

/* -------------------------------------------------------------- 完整性 */

test('完整性：缺专辑名 / 缺艺术家 / 解析失败判定为关键缺失', () => {
  const { albumId } = addTrack({ album: null, dir: 'E:\\Music\\Loose', artist: null, albumArtist: null, title: 'no tag', titleSource: 'filename' });
  const info = completeness.completenessForAlbum(albumId);
  assert.equal(info.status, 'critical');
  assert.ok(info.missing.includes('album_name'));
  assert.ok(info.missing.includes('track_artist'));
  assert.ok(info.missing.includes('title_from_filename'));
});

test('完整性：信息齐全的专辑为 complete', () => {
  const { albumId } = addTrack({ album: '完整专辑', artist: '完整艺术家', trackNo: 3, year: 1999, genre: 'Rock' });
  tags.applyAlbumTags([albumId], { add: ['完整标签'] });
  store.applyCover(albumId, { hash: 'hash-complete', file: 'hash-complete.jpg', mime: 'image/jpeg', source: 'embedded' });
  const info = completeness.completenessForAlbum(albumId);
  assert.equal(info.status, 'complete', JSON.stringify(info.missing));
  assert.deepEqual(info.missing, []);
});

test('完整性：建议项缺失（无封面/无年份/无标签）为 advisory', () => {
  const { albumId } = addTrack({ album: '建议项缺失', artist: '某人', trackNo: 1 });
  const info = completeness.completenessForAlbum(albumId);
  assert.equal(info.status, 'advisory');
  assert.ok(info.missing.includes('cover'));
  assert.ok(info.missing.includes('year'));
  assert.ok(info.missing.includes('tags'));
});

test('完整性：合辑豁免"缺专辑艺术家"', () => {
  const { albumId } = addTrack({ album: '合辑专辑', artist: '多人', albumArtist: null, trackNo: 1 });
  store.setAlbumCompilation(albumId, true);
  const info = completeness.completenessForAlbum(albumId);
  assert.ok(!info.missing.includes('album_artist'), '合辑不报缺专辑艺术家');
});

test('完整性：可忽略的建议项被排除，关键项不允许忽略', () => {
  const { albumId } = addTrack({ album: '忽略测试', artist: '某人', trackNo: 1 });
  assert.ok(completeness.IGNORABLE_KEYS.includes('year'));
  assert.ok(!completeness.IGNORABLE_KEYS.includes('album_name'));

  completeness.ignoreMissing(albumId, 'year');
  const info = completeness.completenessForAlbum(albumId);
  assert.ok(!info.missing.includes('year'), '忽略后不再提示');
  assert.ok(info.ignored.includes('year'));

  assert.throws(() => completeness.ignoreMissing(albumId, 'album_name'), /不允许忽略/);

  completeness.ignoreMissing(albumId, 'year', true);
  assert.ok(completeness.completenessForAlbum(albumId).missing.includes('year'), '可恢复');
});

test('完整性：工作台汇总包含分组计数与总数', () => {
  const summary = completeness.incompleteSummary();
  assert.ok(summary.total > 0);
  assert.equal(summary.total, summary.complete + summary.critical + summary.advisory);
  assert.ok(summary.groups.length > 0);
  assert.ok(summary.groups.every((g) => g.count > 0 && g.label));

  const criticalOnly = completeness.listIncomplete({ status: 'critical' });
  assert.ok(criticalOnly.albums.every((a) => a.status === 'critical'));

  const coverGroup = completeness.listIncomplete({ group: 'cover' });
  assert.ok(coverGroup.albums.every((a) => a.missing.includes('cover')));
});

/* ---------------------------------------------------------------- 列表查询 */

test('列表：关键词可命中标签名', () => {
  const { albumId } = addTrack({ album: '标签检索专辑', artist: '检索人', trackNo: 1 });
  tags.applyAlbumTags([albumId], { add: ['深夜循环'] });

  const byTag = store.listAlbums({ q: '深夜循环' });
  assert.ok(byTag.some((a) => a.id === albumId), '关键词命中标签');

  const byArtist = store.listAlbums({ q: '检索人' });
  assert.ok(byArtist.some((a) => a.id === albumId));
});

test('列表：标签筛选 AND 语义与计数一致', () => {
  const tagA = tags.ensureTag('筛选甲');
  const tagB = tags.ensureTag('筛选乙');
  const both = addTrack({ album: '双标签专辑', artist: '筛选人', trackNo: 1 });
  const onlyA = addTrack({ album: '单标签专辑', artist: '筛选人', trackNo: 1 });
  tags.applyAlbumTags([both.albumId], { add: [tagA.id, tagB.id] });
  tags.applyAlbumTags([onlyA.albumId], { add: [tagA.id] });

  const andResult = store.listAlbums({ tagIds: [tagA.id, tagB.id], tagMode: 'and' });
  const ids = andResult.map((a) => a.id);
  assert.ok(ids.includes(both.albumId));
  assert.ok(!ids.includes(onlyA.albumId));

  const total = store.countAlbumsFiltered({ tagIds: [tagA.id], tagMode: 'or' });
  assert.ok(total >= 2);
});

test('列表：分页 offset 与 limit 行为正确（修复 D2 的基础）', () => {
  const all = store.listAlbums({ limit: 500, offset: 0 });
  assert.ok(all.length > 2);
  const page1 = store.listAlbums({ limit: 2, offset: 0 });
  const page2 = store.listAlbums({ limit: 2, offset: 2 });
  assert.equal(page1.length, 2);
  assert.notEqual(page1[0].id, page2[0]?.id);
  const total = store.countAlbumsFiltered({});
  assert.equal(total, all.length, '计数与列表长度一致');
});

test('列表：每张专辑带封面地址字段', () => {
  const albums = store.listAlbums({ limit: 500 });
  assert.ok(albums.every((a) => 'cover_url' in a));
  assert.ok(albums.some((a) => a.cover_url));
});

/* ------------------------------------ 从音乐库移除专辑 + 扫描自动忽略 */

test('移除：deleteAlbumDeep 清掉曲目、版本、标签关联与专辑行', () => {
  const made = addTrack({ album: '待移除专辑', artist: '移除测试', trackNo: 1 });
  const tag = tags.ensureTag('移除用标签');
  tags.applyAlbumTags([made.albumId], { add: [tag.id] });
  assert.ok(store.getAlbumById(made.albumId), '前置：专辑存在');
  assert.equal(tags.getAlbumTags(made.albumId).length, 1, '前置：标签已关联');

  const info = store.deleteAlbumDeep(made.albumId);

  assert.equal(info.tracks, 1, '应删掉 1 条曲目');
  assert.equal(store.getAlbumById(made.albumId), null, '专辑行已删除');
  assert.equal(store.listAlbumTracks(made.albumId).length, 0, '曲目已清空');
  assert.equal(tags.getAlbumTags(made.albumId).length, 0, '标签关联已解除');
});

test('移除：排除清单按 album_key 与目录匹配，重复移除只留一条', () => {
  const dir = 'E:\\Music\\移除测试库\\专辑A';
  const albumKey = 'alb\u0000移除测试\u0000专辑A';
  store.addExclusion({ kind: 'music', albumKey, rootPath: dir, title: '专辑A', trackCount: 3 });

  const idx = store.exclusionIndex();
  assert.equal(idx.size, 1);
  assert.ok(idx.byKey(albumKey), '按 album_key 命中');
  assert.ok(idx.byKey(albumKey.toUpperCase()), '键匹配大小写不敏感');
  assert.ok(idx.byPath(dir), '按目录兜底命中');
  assert.ok(idx.byPath(dir.toLowerCase()), '路径匹配大小写不敏感');
  assert.ok(!idx.byPath('E:\\Music\\别的目录'), '别的目录不命中');

  // 同一专辑再次移除：更新记录而不是新增
  store.addExclusion({ kind: 'music', albumKey, rootPath: dir, title: '专辑A（改名）', trackCount: 5 });
  const rows = store.listExclusions().filter((r) => r.album_key === albumKey);
  assert.equal(rows.length, 1, '同一专辑只留一条');
  assert.equal(rows[0].track_count, 5, '再次移除会更新记录');
  assert.equal(rows[0].title, '专辑A（改名）');
  assert.equal(store.countExclusions(), 1);
});

test('移除：恢复（删掉排除记录）后清单清空，排除缓存重建为空', () => {
  const before = store.listExclusions();
  assert.ok(before.length >= 1, '前置：清单里有记录');
  const n = store.deleteExclusions([before[0].id]);
  assert.equal(n, 1);
  assert.equal(store.countExclusions(), before.length - 1);

  store.clearExclusions();
  assert.equal(store.countExclusions(), 0);
  assert.equal(store.exclusionIndex().size, 0, '清空后不再命中任何专辑');
});
