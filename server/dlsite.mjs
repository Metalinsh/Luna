/**
 * DLsite 音声元数据索引（v1.2.5）—— 按 RJ 号查社团 / 声优。
 *
 * 数据来源：`Dlsite/rj_index.sqlite3`（外部脚本抓取、每周增量更新），单表 `works`：
 *   rj TEXT PRIMARY KEY, circle TEXT, voice_actors TEXT(JSON 数组), title, release_date
 *
 * 为什么单独开一个只读库而不并进 library.db：
 *   · 索引是**可重建的外部数据**，19 MB、7.8 万条，和用户资产（标签/收藏）性质不同；
 *   · 更新方式就是整个文件替换，并进 library.db 后既不好换也不好在迁移里兜底；
 *   · 只读连接、**查完即关**：替换索引文件后无需重启，也不会因长期占用而让外部更新失败。
 *
 * 查找规则（用户指定）：
 *   1. 音声发行有 RJ 号 → 索引里精确匹配 `rj`；
 *   2. 匹配不到**不猜**：不做名称模糊匹配，留给用户手工填写。
 *
 * RJ 号两种长度都合法，索引里存的就是原样，**不要补零**：
 *   RJ123218（旧作，6 位）与 RJ01128508（8 位）是两套编号，`RJ00xxxxxx` 里也有真作品。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { APP_ROOT, DATA_DIR } from './config.mjs';

export const INDEX_FILE_NAME = 'rj_index.sqlite3';

/** RJ 号允许 6 位或 8 位数字（与 asmr.mjs 的 RJ_PATTERN 一致） */
const RJ_RE = /^RJ\d{6,8}$/;

/**
 * 索引位置：**data/Dlsite 为主，程序目录 Dlsite/ 兜底**。
 *   · data/ 跟着用户走：升级只覆盖程序文件，索引与库一起保留，也能随时整文件替换更新；
 *   · 程序目录那份是开发机 / 便携包自带的位置，data/ 里没有时直接用它。
 * 测试与高级用法可用 `LUNA_DLSITE_INDEX` 指向任意文件 —— **显式指定即以它为准**，
 * 文件不存在就是「没有索引」，不再回落到默认位置（否则改不动、也测不了）。
 */
export function indexCandidates() {
  const env = String(process.env.LUNA_DLSITE_INDEX ?? '').trim();
  if (env) return [path.resolve(env)];
  const list = [
    path.join(DATA_DIR, 'Dlsite', INDEX_FILE_NAME),
    path.join(DATA_DIR, 'dlsite', INDEX_FILE_NAME),
    path.join(APP_ROOT, 'Dlsite', INDEX_FILE_NAME),
  ];
  // 同一路径只留一次（三处常常全落在同一目录）
  const seen = new Set();
  return list.filter((p) => {
    const key = p.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 当前生效的索引文件路径；没有则 null */
export function resolveIndexPath() {
  for (const file of indexCandidates()) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch { /* 不存在就当没有 */ }
  }
  return null;
}

/**
 * 索引统计的缓存（只缓存数字，不缓存连接）与最近一次错误。
 * 连接**每次查完就关**：索引是外部脚本定期替换的文件，Windows 下长期占用会让
 * 「替换索引」报文件被占用。单次 open+query+close 实测约 0.08 ms，完全可以承受。
 */
let countCache = { path: null, mtimeMs: -1, works: 0 };
let lastError = null;

/** 测试与「索引已更新」后手动清缓存用 */
export function resetIndexCache() {
  countCache = { path: null, mtimeMs: -1, works: 0 };
  lastError = null;
}

/**
 * 打开索引（调用方负责关闭）。
 * 用 `readOnly` 打开：索引是外部数据，任何情况下都不该被本程序写坏；
 * 个别环境下该选项不被接受时退回普通打开（只执行 SELECT）。
 * 结构校验失败一律当「没有索引」：宁可不打标签，也不要抛错打断扫描。
 */
function openIndex() {
  const file = resolveIndexPath();
  if (!file) return null;
  let mtimeMs = -1;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return null; }

  let db = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    try { db = new DatabaseSync(file); } catch (err) {
      lastError = err.message;
      return null;
    }
  }
  try {
    db.prepare('SELECT 1 FROM works LIMIT 1').get();
  } catch (err) {
    try { db.close(); } catch { /* 忽略 */ }
    lastError = err.message;
    return null;
  }
  lastError = null;
  return { db, file, mtimeMs };
}

const closeQuietly = (db) => { try { db.close(); } catch { /* 已关闭 */ } };

/** 索引概况（诊断用：/api/health、扫描报告） */
export function indexInfo() {
  const opened = openIndex();
  if (!opened) {
    return { available: false, path: resolveIndexPath(), works: 0, error: lastError };
  }
  try {
    if (countCache.path !== opened.file || countCache.mtimeMs !== opened.mtimeMs) {
      let works = 0;
      try { works = opened.db.prepare('SELECT COUNT(*) AS n FROM works').get().n; } catch { works = 0; }
      countCache = { path: opened.file, mtimeMs: opened.mtimeMs, works };
    }
    return { available: true, path: opened.file, works: countCache.works, error: null };
  } finally {
    closeQuietly(opened.db);
  }
}

/** RJ 号归一化：去空白、转大写；格式不对返回 null（不猜、不补零） */
export function normalizeRj(value) {
  const s = String(value ?? '').replace(/\s+/g, '').toUpperCase();
  return RJ_RE.test(s) ? s : null;
}

/** 文本清理：去首尾空白、内部连续空白归一（与标签名规范化口径一致） */
const cleanText = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** 声优字段是 JSON 数组；坏数据按空处理，绝不让扫描因为一条脏记录中断 */
export function parseVoiceActors(raw) {
  if (Array.isArray(raw)) return normalizeNames(raw);
  const text = String(raw ?? '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? normalizeNames(parsed) : [];
  } catch {
    return [];
  }
}

function normalizeNames(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const name = cleanText(item);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * 按 RJ 号查一条作品。
 * @returns {{rj:string,circle:string|null,voiceActors:string[],title:string|null,releaseDate:string|null}|null}
 *   索引不存在、格式不对、查不到，一律返回 null（调用方据此走「等用户手工填写」）。
 */
export function lookupWork(rjCode) {
  const code = normalizeRj(rjCode);
  if (!code) return null;
  const opened = openIndex();
  if (!opened) return null;
  try {
    const row = opened.db.prepare(
      'SELECT rj, circle, voice_actors, title, release_date FROM works WHERE rj = ?',
    ).get(code);
    if (!row) return null;
    return {
      rj: row.rj,
      circle: cleanText(row.circle) || null,
      voiceActors: parseVoiceActors(row.voice_actors),
      title: cleanText(row.title) || null,
      releaseDate: cleanText(row.release_date) || null,
    };
  } catch (err) {
    lastError = err.message;
    return null;
  } finally {
    closeQuietly(opened.db);
  }
}

/**
 * 算出「这张专辑该填什么、该打哪些标签」——**不写库**，便于单测与复用。
 *
 * 规则（用户指定）：
 *   · 社团 / 艺术家字段**只填空位**：已有值（含手工填的、标签识别出的）一律不动；
 *   · 艺术家还有「待确认建议」时也不填，避免和现有的建议流程抢着改同一个字段；
 *   · 标签则按索引里的社团 + 全部声优各建一个同名标签（分类 circle / artist）；
 *   · 名称超过标签上限（`MAX_TAG_NAME`，默认 24）的**跳过建标签**，字段照填 —— 索引里
 *     最长社团名有 41 字，硬塞进标签会被校验拒绝，连带整批失败。
 *
 * @param {object|null} work lookupWork() 的结果
 * @param {{circle?:string, album_artist?:string, artist_suggested?:string}} album 专辑当前值
 * @param {{maxTagName?:number}} opts
 */
export function planDlsiteFill(work, album = {}, { maxTagName = 24 } = {}) {
  const plan = {
    circle: { fill: false, value: null },
    artist: { fill: false, value: null },
    tags: [],
    skipped: [],
  };
  if (!work) return plan;

  const circle = cleanText(work.circle) || null;
  const actors = normalizeNames(work.voiceActors ?? []);
  const currentCircle = cleanText(album.circle);
  const currentArtist = cleanText(album.album_artist);
  const suggested = cleanText(album.artist_suggested);

  if (circle && !currentCircle) plan.circle = { fill: true, value: circle };
  if (actors.length && !currentArtist && !suggested) plan.artist = { fill: true, value: actors[0] };

  const wanted = [];
  if (circle) wanted.push({ name: circle, category: 'circle' });
  for (const name of actors) wanted.push({ name: name, category: 'artist' });
  for (const item of wanted) {
    if (item.name.length > maxTagName) plan.skipped.push({ ...item, reason: 'too-long' });
    else plan.tags.push(item);
  }
  return plan;
}
