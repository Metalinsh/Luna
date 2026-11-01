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

/**
 * 标签所属的**两套独立命名空间**（v1.2.4 起）：
 *   music —— 普通音乐专辑；voice —— 音声（ASMR）发行
 *
 * 同名标签在两套里各存一份（`tags` 的唯一约束是 `(kind, name)`），
 * 给 ASMR 打的「萝莉 / 雌小鬼」不会出现在普通专辑的标签栏里，反之亦然。
 * 一套里能出现哪些标签，由**当前音乐库的类别**决定（见 public/app.js）。
 */
export const TAG_KINDS = ['music', 'voice'];
export const DEFAULT_TAG_KIND = 'music';

export function normalizeTagKind(input) {
  const value = String(input ?? '').trim().toLowerCase();
  return TAG_KINDS.includes(value) ? value : DEFAULT_TAG_KIND;
}

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
  SELECT tg.id, tg.name, tg.kind, tg.color, tg.pinned, tg.category, tg.created_at, tg.updated_at,
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

/**
 * @param {{sort?: string, kind?: string|null}} opts
 *   kind 给定时只返回那一套标签；不给则两套都返回（标签管理页用）。
 */
export function listTags({ sort = 'usage', kind = null } = {}) {
  const order = sort === 'name'
    ? 'tg.name COLLATE NOCASE ASC'
    : 'tg.pinned DESC, album_count DESC, tg.name COLLATE NOCASE ASC';
  const wanted = kind ? normalizeTagKind(kind) : null;
  const where = wanted ? 'WHERE tg.kind = ?' : '';
  const args = wanted ? [wanted] : [];
  return db.prepare(`${TAG_SELECT} ${where} ORDER BY ${order}`).all(...args).map(shape);
}

export function getTag(id) {
  return shape(db.prepare(`${TAG_SELECT} WHERE tg.id = ?`).get(Number(id)));
}

/** 按名字找标签，**必须在指定的一套里找**（默认普通专辑那套） */
export function findTagByName(name, kind = DEFAULT_TAG_KIND) {
  const normalized = normalizeTagName(name);
  if (!normalized) return null;
  return shape(db.prepare(`${TAG_SELECT} WHERE tg.name = ? COLLATE NOCASE AND tg.kind = ?`)
    .get(normalized, normalizeTagKind(kind)));
}

/* ---------------------------------------------------------------- 写入 */

export function createTag(name, color = null, category = DEFAULT_TAG_CATEGORY, kind = DEFAULT_TAG_KIND) {
  const k = normalizeTagKind(kind);
  const check = validateTagName(name);
  if (!check.ok) throw new Error(check.error);
  const existing = findTagByName(check.name, k);
  if (existing) return existing;

  // 调色板按「同一套内」轮转，避免两套各从 0 开始时颜色撞在一起
  const nextColor = color ?? (db.prepare('SELECT COUNT(*) AS n FROM tags WHERE kind = ?').get(k).n % TAG_COLORS);
  const t = now();
  const info = db.prepare(`
    INSERT INTO tags (name, kind, color, pinned, category, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?, ?)
  `).run(check.name, k, Number(nextColor) || 0, normalizeTagCategory(category), t, t);
  return getTag(info.lastInsertRowid);
}

/**
 * 打标时按名字取用，不存在则创建 —— **限定在某一套标签里**。
 *
 * 指定了 category 且已有标签还停在默认的「风格」时顺带归类
 * （例：先手工建了「上海飯店」标签，之后才填写社团）——
 * **只升级、不反悔**：已经是社团/CV 的标签不会被改成别的类，尊重用户在标签页里的手工归类。
 */
export function ensureTag(name, category = null, kind = DEFAULT_TAG_KIND) {
  const k = normalizeTagKind(kind);
  const existing = findTagByName(name, k);
  if (!existing) return createTag(name, null, category ?? DEFAULT_TAG_CATEGORY, k);
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
    // 重名只在**同一套**里冲突：两套各有一个同名标签是合法的
    const clash = findTagByName(name.name, tag.kind);
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
  // 跨套合并没有语义（普通专辑的标签不能变成 ASMR 的），直接拒绝而不是悄悄搬过去
  if (source.kind !== target.kind) throw new Error('只能合并同一套里的标签（普通专辑 / ASMR）');
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
 *
 * **两套标签的关键落点**：每张专辑用它自己的 `kind` 去解析标签 ——
 *   · 传标签名时，在「该专辑所属的那一套」里找/建同名标签
 *   · 传标签 id 时，若该 id 属于另一套，则按名字在本文专辑那套里找/建同名标签
 * 因此批量勾选**混合种类**的专辑也安全：同名标签会自动落到各自那一套里。
 */
export function applyAlbumTags(albumIds, { add = [], remove = [] } = {}) {
  const ids = (albumIds ?? []).map(Number).filter(Number.isFinite);
  if (!ids.length) return { added: 0, removed: 0, created: 0 };

  // 每张专辑的类别 —— 决定它只能用哪一套标签
  const kindOf = new Map(db.prepare(
    `SELECT id, COALESCE(kind, 'music') AS kind FROM albums
      WHERE id IN (${ids.map(() => '?').join(', ')})`,
  ).all(...ids).map((r) => [r.id, normalizeTagKind(r.kind)]));

  // add 统一归一成「名字 + 分类」；传 id 时沿用该标签的名字与分类
  const specs = [];
  for (const item of add) {
    if (typeof item === 'number' || /^\d+$/.test(String(item))) {
      const tag = getTag(Number(item));
      if (tag) specs.push({ name: tag.name, category: tag.category });
      continue;
    }
    const name = normalizeTagName(item);
    if (validateTagName(name).ok) specs.push({ name, category: null });
  }
  const removeIds = (remove ?? []).map(Number).filter((id) => Number.isFinite(id) && getTag(id));

  const t = now();
  let added = 0;
  let removed = 0;
  let created = 0;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO album_tags (album_id, tag_id, source, added_at) VALUES (?, ?, 'manual', ?)
  `);
  const del = db.prepare('DELETE FROM album_tags WHERE album_id = ? AND tag_id = ?');

  // 同一套里的同名标签只解析一次
  const resolved = new Map();
  const resolveTagId = (spec, kind) => {
    const key = `${kind}|${spec.name.toLowerCase()}`;
    if (resolved.has(key)) return resolved.get(key);
    const before = findTagByName(spec.name, kind);
    const tag = before ?? createTag(spec.name, null, spec.category ?? DEFAULT_TAG_CATEGORY, kind);
    if (!before) created += 1;
    resolved.set(key, tag.id);
    return tag.id;
  };

  for (const albumId of ids) {
    const kind = kindOf.get(albumId) ?? DEFAULT_TAG_KIND;
    for (const spec of specs) added += insert.run(albumId, resolveTagId(spec, kind), t).changes;
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
