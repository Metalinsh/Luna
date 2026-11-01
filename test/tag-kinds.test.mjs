/**
 * 两套标签（普通专辑 / ASMR）—— schema v12。
 *
 * 覆盖三件事：
 *   1) 迁移：旧的全局标签按专辑类别拆分，关联不串套
 *   2) 同名标签在两套里各存一份，查找/列举都按套隔离
 *   3) 打标自动落到专辑所属那一套（含混合批量），跨套合并被拒绝
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-tagkinds-'));
const dbFile = path.join(dataDir, 'library.db');

/*
 * 先造一个 **v11 时代** 的库：tags 还是全局命名空间（name UNIQUE，没有 kind 列），
 * 然后加载 db.mjs 触发 v12 迁移，验证拆分逻辑。
 */
{
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      album_key TEXT NOT NULL UNIQUE,
      title TEXT, album_artist TEXT, year INTEGER,
      kind TEXT NOT NULL DEFAULT 'music'
    );
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      color INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      category TEXT NOT NULL DEFAULT 'style',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE album_tags (
      album_id INTEGER NOT NULL, tag_id INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual', added_at INTEGER NOT NULL,
      PRIMARY KEY (album_id, tag_id)
    );
  `);
  const t = 1_700_000_000_000;
  const insAlbum = db.prepare('INSERT INTO albums (id, album_key, title, kind) VALUES (?, ?, ?, ?)');
  insAlbum.run(1, 'k1', '普通专辑A', 'music');
  insAlbum.run(2, 'k2', '音声发行A', 'voice');
  insAlbum.run(3, 'k3', '音声发行B', 'voice');

  const insTag = db.prepare(`
    INSERT INTO tags (id, name, color, pinned, category, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insTag.run(1, '共用标签', 2, 0, 'style', t, t);   // 两类专辑都关联 → 应当拆成两份
  insTag.run(2, '音声专属', 3, 0, 'circle', t, t);  // 只关联音声 → 只留在 voice
  insTag.run(3, '未使用', 4, 0, 'style', t, t);     // 没关联 → 两套各留一份

  const link = db.prepare('INSERT INTO album_tags (album_id, tag_id, source, added_at) VALUES (?, ?, ?, ?)');
  link.run(1, 1, 'manual', t);   // 普通专辑 ← 共用标签
  link.run(2, 1, 'manual', t);   // 音声     ← 共用标签
  link.run(3, 2, 'manual', t);   // 音声     ← 音声专属
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '11');
  db.close();
}

process.env.LAM_DATA_DIR = dataDir;

let store;
let tags;

before(async () => {
  store = await import('../server/db.mjs');   // 加载即执行迁移（11 → 12）
  tags = await import('../server/tags.mjs');
});

after(() => {
  // Windows 上句柄未释放时删目录会 EPERM —— 清理失败不影响测试结论
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

/** 取某个标签名在各专辑上的「专辑类别 / 标签类别」配对，用来验证有没有串套 */
function pairsFor(name) {
  return store.db.prepare(`
    SELECT a.kind AS album_kind, tg.kind AS tag_kind
    FROM album_tags at
    JOIN albums a ON a.id = at.album_id
    JOIN tags tg ON tg.id = at.tag_id
    WHERE tg.name = ?
    ORDER BY a.id
  `).all(name).map((r) => `${r.album_kind}/${r.tag_kind}`);
}

test('迁移 v12：两类专辑共用的标签被拆成两份，关联各归各套', () => {
  const rows = store.db.prepare("SELECT kind FROM tags WHERE name = '共用标签' ORDER BY kind").all();
  assert.equal(rows.length, 2, '共用标签应拆成两份');
  assert.deepEqual(rows.map((r) => r.kind), ['music', 'voice']);
  assert.deepEqual(pairsFor('共用标签'), ['music/music', 'voice/voice'], '专辑类别与标签类别必须一致');
});

test('迁移 v12：只关联音声的标签留在 ASMR 那套；未使用的两套各留一份', () => {
  const only = store.db.prepare("SELECT kind FROM tags WHERE name = '音声专属'").all();
  assert.equal(only.length, 1);
  assert.equal(only[0].kind, 'voice');

  const unused = store.db.prepare("SELECT COUNT(*) AS n FROM tags WHERE name = '未使用'").get().n;
  assert.equal(unused, 2, '没关联过专辑的标签两套都留，避免用户觉得标签丢了');
});

test('两套标签同名共存，按套查找与列举互不串', () => {
  const m = tags.createTag('同名标签', null, 'style', 'music');
  const v = tags.createTag('同名标签', null, 'style', 'voice');
  assert.notEqual(m.id, v.id, '两套里的同名标签是两个独立实体');

  assert.equal(tags.findTagByName('同名标签', 'music').id, m.id);
  assert.equal(tags.findTagByName('同名标签', 'voice').id, v.id);

  const musicList = tags.listTags({ kind: 'music' }).map((t) => t.id);
  const voiceList = tags.listTags({ kind: 'voice' }).map((t) => t.id);
  assert.ok(musicList.includes(m.id) && !musicList.includes(v.id));
  assert.ok(voiceList.includes(v.id) && !voiceList.includes(m.id));

  // 不传 kind 时两套都给（标签管理页用）
  const all = tags.listTags().map((t) => t.id);
  assert.ok(all.includes(m.id) && all.includes(v.id));
});

test('打标：混合批量会按各专辑的类别落到对应那套', () => {
  const musicId = store.db.prepare("SELECT id FROM albums WHERE kind = 'music' LIMIT 1").get().id;
  const voiceId = store.db.prepare("SELECT id FROM albums WHERE kind = 'voice' LIMIT 1").get().id;

  const res = tags.applyAlbumTags([musicId, voiceId], { add: ['混合批量标签'] });
  assert.ok(res.added >= 2, `应新增至少 2 条关联，实际 ${res.added}`);

  assert.deepEqual(pairsFor('混合批量标签'), ['music/music', 'voice/voice']);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM tags WHERE name = '混合批量标签'").get().n, 2,
    '同一批里两类专辑 → 两套各建一个同名标签');
});

test('打标：传另一套的标签 id 时，按名字在本套重新解析，不会串套', () => {
  const musicTag = tags.findTagByName('同名标签', 'music');
  const voiceAlbum = store.db.prepare("SELECT id FROM albums WHERE kind = 'voice' LIMIT 1").get().id;
  tags.applyAlbumTags([voiceAlbum], { add: [musicTag.id] });

  const voiceTag = tags.findTagByName('同名标签', 'voice');
  const linked = store.db.prepare(
    'SELECT 1 FROM album_tags WHERE album_id = ? AND tag_id = ?',
  ).get(voiceAlbum, voiceTag.id);
  assert.ok(linked, '音声专辑应当关联到 voice 那份');
  const wrong = store.db.prepare(
    'SELECT 1 FROM album_tags WHERE album_id = ? AND tag_id = ?',
  ).get(voiceAlbum, musicTag.id);
  assert.equal(wrong, undefined, '不应把 music 那份直接挂到音声专辑上');
});

test('合并：跨套被拒绝，同套正常合并', () => {
  const m = tags.findTagByName('同名标签', 'music');
  const v = tags.findTagByName('同名标签', 'voice');
  assert.throws(() => tags.mergeTags(m.id, v.id), /同一套/);

  // 先让 music 那份挂上一张普通专辑，否则合并无可迁移的关联
  const musicAlbum = store.db.prepare("SELECT id FROM albums WHERE kind = 'music' LIMIT 1").get().id;
  tags.applyAlbumTags([musicAlbum], { add: [m.id] });

  const target = tags.createTag('合并目标', null, 'style', 'music');
  const res = tags.mergeTags(m.id, target.id);
  assert.ok(res.moved >= 1, '同套合并应迁移关联');
  assert.equal(tags.findTagByName('同名标签', 'music'), null, '源标签已删除');
  assert.equal(tags.findTagByName('同名标签', 'voice')?.id, v.id, '另一套不受影响');
});
