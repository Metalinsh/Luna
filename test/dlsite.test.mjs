/**
 * DLsite 索引（v1.2.5）：按 RJ 号补社团 / 声优。
 *
 * 覆盖四件事：
 *   1) RJ 号归一化与精确查找（两种长度、不补零、脏数据不抛错）
 *   2) 补齐计划：字段只填空位、不抢「待确认建议」、超长名称只跳过标签
 *   3) 落库：只填空白；`dlsite` 来源被扫描锁定，手工值优先
 *   4) 标签：自动补的关联记为 `source='dlsite'`，且落在 ASMR 那一套里
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-dlsite-'));
const dataDir = path.join(tmpDir, 'data');
const indexFile = path.join(tmpDir, 'rj_index.sqlite3');
fs.mkdirSync(dataDir, { recursive: true });

/* 造一份和真实索引同构的小库（字段名、类型、主键都一致） */
{
  const db = new DatabaseSync(indexFile);
  db.exec(`
    CREATE TABLE works (
      rj TEXT PRIMARY KEY,
      circle TEXT,
      voice_actors TEXT,
      voice_actor_text TEXT,
      title TEXT,
      release_date TEXT,
      updated_at TEXT
    );
  `);
  const ins = db.prepare(`INSERT INTO works (rj, circle, voice_actors, title, release_date)
                          VALUES (?, ?, ?, ?, ?)`);
  ins.run('RJ01128508', ' 上海飯店 ', '["小花衣こっこ"]', '即おち!', '2024-01-06');
  // 旧作：6 位编号，索引里就是原样，不补零
  ins.run('RJ123218', 'ristorante', '["伊ヶ崎綾香"]', 'お義姉ちゃん', '2013-12-14');
  // 多声优 + 重复项 + 空白项：去重、去空
  ins.run('RJ309902', '防鯖潤滑剤', '[" 天知遥 ","天知遥","","逢坂成美"]', 'ゲーマーカノジョ', '');
  // 只有 RJ、其余全空（DLsite 已下架的作品在索引里就是这样）
  ins.run('RJ01182623', '', '[]', '', '');
  // 坏 JSON：按空处理，不能让扫描崩
  ins.run('RJ999999', '坏数据社团', 'not-json', '', '');
  // 超长社团名（真实索引里最长 41 字）
  ins.run('RJ888888', '世界リョナ支配計画～Project:World Ryona Domination～', '[]', '', '');
  // 扫描末尾统一补齐用：分别对应「首次补齐」与「签名失效后重补」两个用例
  ins.run('RJ377172', 'YSMR', '["逢坂成美"]', '', '');
  ins.run('RJ317041', 'SWEET×MONSTER', '["天知遥"]', '', '');
  // 索引更新（翻译版社团修正）用：测试里会就地改这两行
  ins.run('RJ700001', '旧社团', '["旧声优"]', '', '');
  ins.run('RJ700002', '旧社团B', '["旧声优B"]', '', '');
  db.close();
}

process.env.LAM_DATA_DIR = dataDir;
process.env.LUNA_DLSITE_INDEX = indexFile;

const dlsite = await import('../server/dlsite.mjs');
const store = await import('../server/db.mjs');
const tagsApi = await import('../server/tags.mjs');
const scanner = await import('../server/scanner.mjs');

/* ------------------------------------------------------------------ 查找 */

test('RJ 归一化：容忍空白与大小写，格式不对一律 null（不补零）', () => {
  assert.equal(dlsite.normalizeRj(' rj01128508 '), 'RJ01128508');
  assert.equal(dlsite.normalizeRj('RJ123218'), 'RJ123218');
  assert.equal(dlsite.normalizeRj('RJ123'), null);        // 位数不足
  assert.equal(dlsite.normalizeRj('RJ123456789'), null);  // 位数超出
  assert.equal(dlsite.normalizeRj('01128508'), null);     // 缺 RJ 前缀
  // 8 位带前导零的编号本身合法，但**绝不**与 6 位的旧作互转
  assert.equal(dlsite.normalizeRj('RJ00123218'), 'RJ00123218');
  for (const v of [null, undefined, '', 0, {}]) assert.equal(dlsite.normalizeRj(v), null);
});

test('索引定位：LUNA_DLSITE_INDEX 优先，且能报出概况', () => {
  assert.equal(dlsite.resolveIndexPath(), path.resolve(indexFile));
  const info = dlsite.indexInfo();
  assert.equal(info.available, true);
  assert.equal(info.works, 10);
  assert.equal(info.error, null);
});

test('按 RJ 查作品：8 位 / 6 位都能命中，文本被清理', () => {
  const a = dlsite.lookupWork('rj01128508');
  assert.equal(a.rj, 'RJ01128508');
  assert.equal(a.circle, '上海飯店');           // 首尾空白被去掉
  assert.deepEqual(a.voiceActors, ['小花衣こっこ']);

  const b = dlsite.lookupWork('RJ123218');      // 旧作 6 位，不做补零转换
  assert.equal(b.circle, 'ristorante');
  assert.deepEqual(b.voiceActors, ['伊ヶ崎綾香']);
});

test('按 RJ 查作品：多声优去重去空，坏 JSON / 缺失字段不抛错', () => {
  const work = dlsite.lookupWork('RJ309902');
  assert.deepEqual(work.voiceActors, ['天知遥', '逢坂成美']);

  const gone = dlsite.lookupWork('RJ01182623');  // 已下架：只剩 RJ，没有社团与声优
  assert.equal(gone.circle, null);
  assert.deepEqual(gone.voiceActors, []);

  const broken = dlsite.lookupWork('RJ999999');
  assert.equal(broken.circle, '坏数据社团');
  assert.deepEqual(broken.voiceActors, []);
});

test('按 RJ 查作品：查不到 / 格式非法 / 空值 -> null（不猜）', () => {
  assert.equal(dlsite.lookupWork('RJ000000'), null);
  assert.equal(dlsite.lookupWork('RJ123'), null);
  assert.equal(dlsite.lookupWork(null), null);
  assert.equal(dlsite.lookupWork(''), null);
});

/* -------------------------------------------------------------- 补齐计划 */

test('补齐计划：空专辑 → 社团与声优都填，并各建一个标签', () => {
  const work = dlsite.lookupWork('RJ01128508');
  const plan = dlsite.planDlsiteFill(work, {}, { maxTagName: 24 });
  assert.deepEqual(plan.circle, { fill: true, value: '上海飯店' });
  assert.deepEqual(plan.artist, { fill: true, value: '小花衣こっこ' });
  assert.deepEqual(plan.tags, [
    { name: '上海飯店', category: 'circle' },
    { name: '小花衣こっこ', category: 'artist' },
  ]);
  assert.deepEqual(plan.skipped, []);
});

test('补齐计划：已有值不覆盖，标签照打（用户要求「只填空位、标签按 DLsite 数据」）', () => {
  const work = dlsite.lookupWork('RJ01128508');
  const plan = dlsite.planDlsiteFill(work, { circle: '测试社团XYZ', album_artist: '手工声优' }, { maxTagName: 24 });
  assert.equal(plan.circle.fill, false);
  assert.equal(plan.artist.fill, false);
  assert.equal(plan.tags.length, 2, '字段已有值不影响补标签');
});

test('补齐计划：有「待确认建议」时不抢艺术家的字段', () => {
  const work = dlsite.lookupWork('RJ309902');
  const plan = dlsite.planDlsiteFill(work, { artist_suggested: '标签建议的声优' }, { maxTagName: 24 });
  assert.equal(plan.artist.fill, false, '建议值正在等用户确认，不该被自动值覆盖');
  assert.deepEqual(plan.tags.map((t) => t.name), ['防鯖潤滑剤', '天知遥', '逢坂成美']);
});

test('补齐计划：名称超过标签上限 → 跳过标签、字段照填', () => {
  const work = dlsite.lookupWork('RJ888888');
  const plan = dlsite.planDlsiteFill(work, {}, { maxTagName: 24 });
  assert.equal(plan.circle.fill, true);
  assert.equal(plan.circle.value.length, 41);
  assert.deepEqual(plan.tags, []);
  assert.deepEqual(plan.skipped.map((s) => s.reason), ['too-long']);
});

test('补齐计划：没查到作品时什么都不做', () => {
  const plan = dlsite.planDlsiteFill(null, {});
  assert.deepEqual(plan, {
    circle: { fill: false, value: null },
    artist: { fill: false, value: null },
    tags: [],
    skipped: [],
  });
});

/* ---------------------------------------------------------------- 落库 */

/** 造一张音声发行（模拟扫描入库） */
function makeVoiceAlbum(rj, root) {
  return store.upsertVoiceAlbum({
    releaseRoot: root ?? `E:\\ASMR\\[${rj}]作品`,
    rjCode: rj,
    title: `作品 ${rj}`,
  });
}

test('落库：只填空白字段，写入来源标成 dlsite', () => {
  const id = makeVoiceAlbum('RJ01128508');
  assert.equal(store.fillAlbumCircleIfEmpty(id, '上海飯店'), true);
  assert.equal(store.fillAlbumArtistIfEmpty(id, '小花衣こっこ'), true);

  const album = store.getAlbumById(id);
  assert.equal(album.circle, '上海飯店');
  assert.equal(album.album_artist, '小花衣こっこ');
  assert.equal(album.album_artist_source, 'dlsite');

  // 再补一次：非空就不动
  assert.equal(store.fillAlbumCircleIfEmpty(id, '别的社团'), false);
  assert.equal(store.fillAlbumArtistIfEmpty(id, '别的声优'), false);
  assert.equal(store.getAlbumById(id).circle, '上海飯店');
});

test('落库：手工值优先，自动补齐不覆盖', () => {
  const id = makeVoiceAlbum('RJ123218');
  assert.equal(store.setAlbumArtistManual(id, '手工声优'), true);
  assert.equal(store.setAlbumCircle(id, '手工社团'), '手工社团');

  assert.equal(store.fillAlbumCircleIfEmpty(id, 'ristorante'), false);
  assert.equal(store.fillAlbumArtistIfEmpty(id, '伊ヶ崎綾香'), false);
  const album = store.getAlbumById(id);
  assert.equal(album.circle, '手工社团');
  assert.equal(album.album_artist, '手工声优');
  assert.equal(album.album_artist_source, 'manual');
});

test('落库：DLsite 补的声优在后续扫描里不被清掉（来源锁定）', () => {
  const root = 'E:\\ASMR\\[RJ309902]ゲーマーカノジョ';
  const id = makeVoiceAlbum('RJ309902', root);
  store.fillAlbumArtistIfEmpty(id, '天知遥');
  assert.equal(store.getAlbumById(id).album_artist_source, 'dlsite');

  // 模拟下一轮扫描：压缩包不读标签，解析不到任何艺术家
  store.upsertVoiceAlbum({ releaseRoot: root, rjCode: 'RJ309902', title: '作品', artist: null });
  assert.equal(store.getAlbumById(id).album_artist, '天知遥', 'dlsite 来源应像手工值一样被保留');
});

test('落库：有「待确认建议」时不填艺术家', () => {
  // 直接构造建议值（模拟标签艺术家与专辑艺术家冲突的场景）
  const id = store.upsertVoiceAlbum({
    releaseRoot: 'E:\\ASMR\\[RJ888888]x',
    rjCode: 'RJ888888',
    title: 'x',
    artist: null,
    artistSuggested: '标签建议的声优',
  });
  assert.equal(store.getAlbumById(id).artist_suggested, '标签建议的声优');
  assert.equal(store.fillAlbumArtistIfEmpty(id, '索引声优'), false);
  assert.equal(store.getAlbumById(id).album_artist, null);
});

/* ---------------------------------------------------------------- 标签 */

test('标签：自动补齐的关联记为 dlsite，落在 ASMR 那一套里', () => {
  const id = makeVoiceAlbum('RJ01128508');
  const circle = tagsApi.ensureTag('上海飯店', 'circle', 'voice');
  const actor = tagsApi.ensureTag('小花衣こっこ', 'artist', 'voice');
  const res = tagsApi.applyAlbumTags([id], { add: [circle.id, actor.id], source: 'dlsite' });
  assert.equal(res.added, 2);
  assert.equal(res.created, 0);

  const got = tagsApi.getAlbumTags(id);
  assert.deepEqual(got.map((t) => t.name).sort(), ['上海飯店', '小花衣こっこ'].sort());
  assert.ok(got.every((t) => t.source === 'dlsite'), '来源应记为 dlsite');

  // 两套命名空间隔离：普通专辑那套里没有这两个标签
  assert.equal(tagsApi.findTagByName('上海飯店', 'music'), null);
  assert.equal(circle.kind, 'voice');
  assert.equal(actor.kind, 'voice');
});

test('标签：同一对关联已存在时保留原来源（手工优先于自动）', () => {
  const id = makeVoiceAlbum('RJ123218');
  const tag = tagsApi.ensureTag('ristorante', 'circle', 'voice');
  tagsApi.applyAlbumTags([id], { add: [tag.id] });                    // 手工
  const again = tagsApi.applyAlbumTags([id], { add: [tag.id], source: 'dlsite' });
  assert.equal(again.added, 0);
  assert.equal(tagsApi.getAlbumTags(id)[0].source, 'manual');
});

/* ------------------------------------------------- 扫描末尾的统一补齐 */

test('统一补齐：从不入库的压缩包专辑也能补上字段与标签（回归：增量跳过）', () => {
  /*
   * 压缩包自 v1.2.4 起按 size+mtime 增量跳过，被跳过的包不会走 ingestRelease。
   * 以前把补齐挂在入库流程里，存量库里所有压缩包专辑都补不上 —— 这里显式模拟：
   * 只建专辑、不跑任何入库，然后调补齐入口。
   */
  const zipA = makeVoiceAlbum('RJ123218', 'E:\\ASMR\\[RJ123218] お義姉ちゃん.zip');
  const zipB = makeVoiceAlbum('RJ309902', 'E:\\ASMR\\[RJ309902] ゲーマーカノジョ.zip');
  assert.equal(store.getAlbumById(zipA).circle, null);
  assert.equal(store.getAlbumById(zipB).circle, null);

  const matched = scanner.applyDlsiteToVoiceAlbums();
  assert.ok(matched >= 2, `应至少命中 2 张，实际 ${matched}`);

  const a = store.getAlbumById(zipA);
  assert.equal(a.circle, 'ristorante');
  assert.equal(a.album_artist, '伊ヶ崎綾香');
  const b = store.getAlbumById(zipB);
  assert.equal(b.circle, '防鯖潤滑剤');
  assert.equal(b.album_artist, '天知遥');

  const tagNames = tagsApi.getAlbumTags(zipA).map((t) => t.name);
  assert.deepEqual(tagNames.sort(), ['ristorante', '伊ヶ崎綾香'].sort());
});

test('统一补齐：用户删掉的 DLsite 标签不会被下一轮扫描加回来', () => {
  const id = makeVoiceAlbum('RJ377172', 'E:\\ASMR\\[RJ377172] 年下幼馴染み.zip');
  scanner.applyDlsiteToVoiceAlbums();
  const first = tagsApi.getAlbumTags(id);
  assert.equal(first.length, 2, '首次补齐应打上社团与声优两个标签');

  tagsApi.applyAlbumTags([id], { remove: first.map((t) => t.id) });
  assert.deepEqual(tagsApi.getAlbumTags(id), []);

  scanner.applyDlsiteToVoiceAlbums();   // 再扫一轮
  assert.deepEqual(tagsApi.getAlbumTags(id), [], '删掉的标签不该自己长回来');

  // 字段仍是补齐后的值，不受标签删改影响
  const album = store.getAlbumById(id);
  assert.equal(album.circle, 'YSMR');
  assert.equal(album.album_artist, '逢坂成美');
});

test('统一补齐：索引数据变化（签名失效）后按新数据重新补一次', () => {
  const id = makeVoiceAlbum('RJ317041', 'E:\\ASMR\\[RJ317041] 嫁と嫁.zip');
  scanner.applyDlsiteToVoiceAlbums();
  const first = tagsApi.getAlbumTags(id);
  assert.ok(first.length >= 2);
  tagsApi.applyAlbumTags([id], { remove: first.map((t) => t.id) });

  // 模拟索引里这条作品的数据变了（签名不再是当初补的那个）
  store.setMeta(`dlsite_tags:${id}`, 'v0|RJ000000|旧数据');
  scanner.applyDlsiteToVoiceAlbums();
  assert.deepEqual(tagsApi.getAlbumTags(id).map((t) => t.name).sort(), ['SWEET×MONSTER', '天知遥']);
});

/** 就地改一行索引，模拟「DLsite 更新了这条作品的数据」 */
function updateWork(rj, circle, actors) {
  const db = new DatabaseSync(indexFile);
  db.prepare('UPDATE works SET circle = ?, voice_actors = ? WHERE rj = ?')
    .run(circle, JSON.stringify(actors), rj);
  db.close();
}

test('索引更新：当初自动补进去的社团 / 声优跟着修正，旧标签被撤掉', () => {
  const id = makeVoiceAlbum('RJ700001', 'E:\\ASMR\\[RJ700001] 翻译版.zip');
  scanner.applyDlsiteToVoiceAlbums();
  assert.equal(store.getAlbumById(id).circle, '旧社团');
  assert.equal(store.getAlbumById(id).album_artist, '旧声优');
  assert.deepEqual(tagsApi.getAlbumTags(id).map((t) => t.name).sort(), ['旧声优', '旧社团'].sort());

  // 模拟抓取端修正了翻译版的社团名（真实案例：RJ01113481 / RJ01307571）
  updateWork('RJ700001', '新社团', ['新声优']);
  scanner.applyDlsiteToVoiceAlbums();

  const a = store.getAlbumById(id);
  assert.equal(a.circle, '新社团', '当初由索引填的社团要跟着改');
  assert.equal(a.album_artist, '新声优', 'dlsite 来源的声优要跟着改');
  assert.deepEqual(
    tagsApi.getAlbumTags(id).map((t) => t.name).sort(),
    ['新声优', '新社团'].sort(),
    '旧标签必须撤掉，不能新旧并存',
  );
});

test('索引更新：手工填的社团 / 声优不动，但自动标签跟着索引走', () => {
  const id = makeVoiceAlbum('RJ700002', 'E:\\ASMR\\[RJ700002] 手工改过.zip');
  scanner.applyDlsiteToVoiceAlbums();
  assert.equal(store.getAlbumById(id).circle, '旧社团B');

  store.setAlbumCircle(id, '我手工填的社团');       // 用户改了社团
  store.setAlbumArtistManual(id, '我手工填的声优');  // 用户改了声优

  updateWork('RJ700002', '新社团B', ['新声优B']);
  scanner.applyDlsiteToVoiceAlbums();

  const a = store.getAlbumById(id);
  assert.equal(a.circle, '我手工填的社团', '手工值不该被索引改掉');
  assert.equal(a.album_artist, '我手工填的声优');
  assert.equal(a.album_artist_source, 'manual');

  const names = tagsApi.getAlbumTags(id).map((t) => t.name);
  assert.ok(names.includes('新社团B'), '标签仍按最新索引补齐');
  assert.ok(!names.includes('旧社团B'), '旧自动标签撤掉');
  assert.ok(names.includes('新声优B'), '自动补的声优标签也该更新');
});

test('统一补齐：索引缺失时不报错、不改任何字段', () => {
  const id = makeVoiceAlbum('RJ777777', 'E:\\ASMR\\[RJ777777] 无索引.zip');
  process.env.LUNA_DLSITE_INDEX = path.join(tmpDir, '不存在', 'rj_index.sqlite3');
  dlsite.resetIndexCache();
  try {
    assert.equal(dlsite.indexInfo().available, false);
    assert.equal(scanner.applyDlsiteToVoiceAlbums(), 0);
    const album = store.getAlbumById(id);
    assert.equal(album.circle, null);
    assert.equal(album.album_artist, null);
    assert.equal(scanner.scanState.dlsiteIndexMissing, true);
  } finally {
    process.env.LUNA_DLSITE_INDEX = indexFile;
    dlsite.resetIndexCache();
  }
});
