/**
 * 标签体系（设计文档 5.5）：专辑级多标签、CRUD、合并、批量打标与标签检索。
 * 标签是"用户资产"，删除专辑不会删除标签本身。
 */
import { db } from './db.mjs';

const now = () => Date.now();
export const MAX_TAG_NAME = 24;
export const TAG_COLORS = 8;

/**
 * 标签三大分类（产品要求）：风格 / 社团 / CV（艺术家）。
 * 专辑墙上方按这三类分栏展示，便于按社团、按 CV 快速筛选。
 */
export const TAG_CATEGORIES = ['style', 'circle', 'artist'];
export const DEFAULT_TAG_CATEGORY = 'style';

export function normalizeTagCategory(input) {
  const value = String(input ?? '').trim().toLowerCase();
  return TAG_CATEGORIES.includes(value) ? value : DEFAULT_TAG_CATEGORY;
}

/**
 * 在专辑墙分栏里**固定排到首位**的标签（按名称匹配）。
 *
 * 「已预读」是应用自己维护的状态标签，含义是「这张专辑随时可以立刻播」——
 * 用户扫一眼标签栏就该看到自己预读过哪些，因此它不跟随使用频次排序，
 * 固定排在自己所属分类（风格栏）的最前面。返回的列表里用 `lead` 标记，
 * 具体排序在界面层完成（见 public/app.js 的 groupTagsByCategory）。
 */
export const LEAD_TAG_NAMES = ['已预读'];
export const isLeadTag = (name) => LEAD_TAG_NAMES.includes(normalizeTagName(name));

/** 标签名规范化：去首尾空格、内部连续空白归一 */
export function normalizeTagName(input) {
  return String(input ?? '').replace(/\s+/g, ' ').trim();
}

export function validateTagName(input) {
  const name = normalizeTagName(input);
  if (!name) return { ok: false, error: '标签名不能为空' };
  if (name.length > MAX_TAG_NAME) return { ok: false, error: `标签名最多 ${MAX_TAG_NAME} 个字符` };
  return { ok: true, name };
}

/* ---------------------------------------------------------------- 查询 */

const TAG_SELECT = `
  SELECT tg.id, tg.name, tg.color, tg.pinned, tg.category, tg.created_at, tg.updated_at,
         (SELECT COUNT(*) FROM album_tags at WHERE at.tag_id = tg.id)          AS album_count,
         (SELECT COUNT(*) FROM album_tags at2 JOIN tracks t ON t.album_id = at2.album_id
           WHERE at2.tag_id = tg.id)                                          AS track_count
  FROM tags tg
`;

/**
 * 统一的返回形状：pinned 转布尔、补上「是否固顶到分栏首位」的标记。
 * 取不到行时**保持 null**（这是既有调用方的约定，别改成 undefined）。
 */
const shape = (r) => (r ? { ...r, pinned: Boolean(r.pinned), lead: isLeadTag(r.name) } : null);

export function listTags({ sort = 'usage' } = {}) {
  const order = sort === 'name'
    ? 'tg.name COLLATE NOCASE ASC'
    : 'tg.pinned DESC, album_count DESC, tg.name COLLATE NOCASE ASC';
  return db.prepare(`${TAG_SELECT} ORDER BY ${order}`).all().map(shape);
}

export function getTag(id) {
  return shape(db.prepare(`${TAG_SELECT} WHERE tg.id = ?`).get(Number(id)));
}

export function findTagByName(name) {
  const normalized = normalizeTagName(name);
  if (!normalized) return null;
  return shape(db.prepare(`${TAG_SELECT} WHERE tg.name = ? COLLATE NOCASE`).get(normalized));
}

/* ---------------------------------------------------------------- 写入 */

export function createTag(name, color = null, category = DEFAULT_TAG_CATEGORY) {
  const check = validateTagName(name);
  if (!check.ok) throw new Error(check.error);
  const existing = findTagByName(check.name);
  if (existing) return existing;

  const nextColor = color ?? (db.prepare('SELECT COUNT(*) AS n FROM tags').get().n % TAG_COLORS);
  const t = now();
  const info = db.prepare(`
    INSERT INTO tags (name, color, pinned, category, created_at, updated_at)
    VALUES (?, ?, 0, ?, ?, ?)
  `).run(check.name, Number(nextColor) || 0, normalizeTagCategory(category), t, t);
  return getTag(info.lastInsertRowid);
}

/**
 * 打标时按名字取用，不存在则创建。
 *
 * 指定了 category 且已有标签还停在默认的「风格」时顺带归类
 * （例：先手工建了「上海飯店」标签，之后才填写社团）——
 * **只升级、不反悔**：已经是社团/CV 的标签不会被改成别的类，尊重用户在标签页里的手工归类。
 */
export function ensureTag(name, category = null) {
  const existing = findTagByName(name);
  if (!existing) return createTag(name, null, category ?? DEFAULT_TAG_CATEGORY);
  if (category) {
    const target = normalizeTagCategory(category);
    if (existing.category !== target && existing.category === DEFAULT_TAG_CATEGORY) {
      db.prepare('UPDATE tags SET category = ?, updated_at = ? WHERE id = ?')
        .run(target, now(), existing.id);
      return getTag(existing.id);
    }
  }
  return existing;
}

export function updateTag(id, patch = {}) {
  const tag = getTag(id);
  if (!tag) throw new Error('标签不存在');
  const name = patch.name !== undefined ? validateTagName(patch.name) : null;
  if (name && !name.ok) throw new Error(name.error);
  if (name && name.ok && name.name.toLowerCase() !== tag.name.toLowerCase()) {
    const clash = findTagByName(name.name);
    if (clash && clash.id !== tag.id) throw new Error('已存在同名标签');
  }
  db.prepare('UPDATE tags SET name = ?, color = ?, pinned = ?, category = ?, updated_at = ? WHERE id = ?')
    .run(
      name?.ok ? name.name : tag.name,
      patch.color !== undefined ? Number(patch.color) : tag.color,
      patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : (tag.pinned ? 1 : 0),
      patch.category !== undefined ? normalizeTagCategory(patch.category) : (tag.category ?? DEFAULT_TAG_CATEGORY),
      now(), tag.id,
    );
  return getTag(tag.id);
}

export function deleteTag(id) {
  const tag = getTag(id);
  if (!tag) return false;
  db.prepare('DELETE FROM album_tags WHERE tag_id = ?').run(Number(id));
  db.prepare('DELETE FROM tags WHERE id = ?').run(Number(id));
  return true;
}

/** 合并：source 的全部关联迁移到 target，随后删除 source */
export function mergeTags(sourceId, targetId) {
  const source = getTag(sourceId);
  const target = getTag(targetId);
  if (!source || !target || source.id === target.id) {
    return { moved: 0, source: null, target };
  }
  const moved = db.prepare(`
    INSERT OR IGNORE INTO album_tags (album_id, tag_id, source, added_at)
    SELECT album_id, ?, source, added_at FROM album_tags WHERE tag_id = ?
  `).run(target.id, source.id).changes;
  db.prepare('DELETE FROM album_tags WHERE tag_id = ?').run(source.id);
  db.prepare('DELETE FROM tags WHERE id = ?').run(source.id);
  return { moved, source, target: getTag(target.id) };
}

/* ------------------------------------------------------------ 专辑打标 */

export function getAlbumTags(albumId) {
  return db.prepare(`
    SELECT tg.id, tg.name, tg.color, at.source, at.added_at
    FROM album_tags at JOIN tags tg ON tg.id = at.tag_id
    WHERE at.album_id = ?
    ORDER BY tg.pinned DESC, tg.name COLLATE NOCASE
  `).all(Number(albumId)).map((r) => ({ ...r, pinned: false }));
}

/** 批量取多张专辑的标签（列表页用，避免 N+1） */
export function getTagsForAlbums(albumIds) {
  const ids = (albumIds ?? []).map(Number).filter(Number.isFinite);
  const map = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return map;
  const rows = db.prepare(`
    SELECT at.album_id, tg.id, tg.name, tg.color
    FROM album_tags at JOIN tags tg ON tg.id = at.tag_id
    WHERE at.album_id IN (${ids.map(() => '?').join(', ')})
    ORDER BY tg.name COLLATE NOCASE
  `).all(...ids);
  for (const row of rows) map.get(row.album_id)?.push({ id: row.id, name: row.name, color: row.color });
  return map;
}

/**
 * 为若干专辑追加/移除标签。add 可传标签 id 或标签名（名字不存在则创建）。
 * 返回 { added, removed, created }
 */
export function applyAlbumTags(albumIds, { add = [], remove = [] } = {}) {
  const ids = (albumIds ?? []).map(Number).filter(Number.isFinite);
  if (!ids.length) return { added: 0, removed: 0, created: 0 };

  let created = 0;
  const addIds = [];
  for (const item of add) {
    if (typeof item === 'number' || /^\d+$/.test(String(item))) {
      const id = Number(item);
      if (getTag(id)) addIds.push(id);
      continue;
    }
    const before = findTagByName(item);
    const tag = before ?? createTag(item);
    if (!before) created += 1;
    addIds.push(tag.id);
  }
  const removeIds = (remove ?? []).map(Number).filter((id) => Number.isFinite(id) && getTag(id));

  const t = now();
  let added = 0;
  let removed = 0;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO album_tags (album_id, tag_id, source, added_at) VALUES (?, ?, 'manual', ?)
  `);
  const del = db.prepare('DELETE FROM album_tags WHERE album_id = ? AND tag_id = ?');
  for (const albumId of ids) {
    for (const tagId of addIds) added += insert.run(albumId, tagId, t).changes;
    for (const tagId of removeIds) removed += del.run(albumId, tagId).changes;
  }
  return { added, removed, created };
}

/** 按标签筛出专辑 id（and = 同时具备，or = 任一） */
export function albumIdsByTags(tagIds, mode = 'and') {
  const ids = (tagIds ?? []).map(Number).filter(Number.isFinite);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');
  if (mode === 'or') {
    return db.prepare(`
      SELECT DISTINCT album_id FROM album_tags WHERE tag_id IN (${placeholders})
    `).all(...ids).map((r) => r.album_id);
  }
  return db.prepare(`
    SELECT album_id FROM album_tags WHERE tag_id IN (${placeholders})
    GROUP BY album_id HAVING COUNT(DISTINCT tag_id) = ?
  `).all(...ids, ids.length).map((r) => r.album_id);
}

/** 清理没有任何专辑的标签（可选维护操作） */
export function pruneUnusedTags() {
  const info = db.prepare(`
    DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM album_tags)
  `).run();
  return info.changes;
}
