/**
 * 完整性规则引擎（设计文档 5.2.3）。
 * 规则只读，不修改任何数据；用于"待完善"提醒、专辑墙角标与工作台。
 */
import { db } from './db.mjs';

/** 缺失项定义：level = required（关键） / advisory（建议） */
export const MISSING_RULES = {
  album_name: { level: 'required', label: '专辑名缺失', hint: '写入专辑名标签后可在专辑墙正确聚合' },
  parse_error: { level: 'required', label: '标签解析失败', hint: '文件可能损坏或格式不受支持' },
  track_artist: { level: 'required', label: '曲目艺术家缺失', hint: '可填写专辑艺术家，或逐曲填写' },
  cover: { level: 'advisory', label: '缺少封面', hint: '可指定本地图片作为封面' },
  album_artist: { level: 'advisory', label: '缺少专辑艺术家', hint: '合辑可忽略此项' },
  year: { level: 'advisory', label: '缺少年份', hint: '' },
  genre: { level: 'advisory', label: '缺少流派', hint: '' },
  tags: { level: 'advisory', label: '还没有标签', hint: '打上标签后即可按分类检索' },
  track_no: { level: 'advisory', label: '部分曲目缺音轨号', hint: '影响专辑内曲目排序' },
  title_from_filename: { level: 'advisory', label: '标题来自文件名', hint: '文件内没有标题标签' },
};

/** 可被用户"忽略"的项（关键项不允许忽略，避免掩盖真问题） */
export const IGNORABLE_KEYS = Object.entries(MISSING_RULES)
  .filter(([, rule]) => rule.level === 'advisory')
  .map(([key]) => key);

const AGGREGATE_SQL = `
  SELECT a.id,
         a.album_key,
         a.title,
         a.album_artist,
         a.year,
         a.genre,
         a.is_compilation,
         a.cover_hash,
         COUNT(t.id)                                                              AS track_count,
         SUM(CASE WHEN t.parse_error IS NOT NULL THEN 1 ELSE 0 END)               AS parse_errors,
         SUM(CASE WHEN t.artist IS NULL OR TRIM(t.artist) = '' THEN 1 ELSE 0 END) AS missing_artist,
         SUM(CASE WHEN t.track_no IS NULL THEN 1 ELSE 0 END)                      AS missing_track_no,
         SUM(CASE WHEN t.title_source = 'filename' THEN 1 ELSE 0 END)             AS title_from_filename,
         (SELECT COUNT(*) FROM album_tags at WHERE at.album_id = a.id)            AS tag_count
  FROM albums a
  LEFT JOIN tracks t ON t.album_id = a.id
`;

function loadIgnores() {
  const map = new Map();
  for (const row of db.prepare('SELECT album_id, key FROM album_ignore').all()) {
    if (!map.has(row.album_id)) map.set(row.album_id, new Set());
    map.get(row.album_id).add(row.key);
  }
  return map;
}

/** 根据聚合行算出该专辑缺失了哪些项（未扣除豁免） */
export function missingKeysFor(row) {
  const keys = [];
  const hasAlbumArtist = Boolean(String(row.album_artist ?? '').trim());

  if (!String(row.title ?? '').trim()) keys.push('album_name');
  if (Number(row.parse_errors) > 0) keys.push('parse_error');
  if (Number(row.missing_artist) > 0 && !hasAlbumArtist) keys.push('track_artist');
  if (!row.cover_hash) keys.push('cover');
  if (!hasAlbumArtist && !row.is_compilation) keys.push('album_artist');
  if (!row.year) keys.push('year');
  if (!String(row.genre ?? '').trim()) keys.push('genre');
  if (Number(row.tag_count) === 0) keys.push('tags');
  if (Number(row.missing_track_no) > 0) keys.push('track_no');
  if (Number(row.title_from_filename) > 0) keys.push('title_from_filename');
  return keys;
}

export function statusFor(keys) {
  if (keys.some((k) => MISSING_RULES[k]?.level === 'required')) return 'critical';
  if (keys.length) return 'advisory';
  return 'complete';
}

/**
 * 全部专辑的完整性概览：Map(albumId → { status, missing, ignored })
 */
export function completenessMap() {
  const ignores = loadIgnores();
  const map = new Map();
  for (const row of db.prepare(`${AGGREGATE_SQL} GROUP BY a.id`).all()) {
    const ignored = ignores.get(row.id) ?? new Set();
    const all = missingKeysFor(row);
    const missing = all.filter((k) => !ignored.has(k));
    map.set(row.id, {
      status: statusFor(missing),
      missing,
      missingDetailed: missing.map((k) => ({ key: k, ...MISSING_RULES[k] })),
      ignored: all.filter((k) => ignored.has(k)),
      counts: {
        track_count: Number(row.track_count),
        parse_errors: Number(row.parse_errors),
        missing_artist: Number(row.missing_artist),
        missing_track_no: Number(row.missing_track_no),
        title_from_filename: Number(row.title_from_filename),
        tag_count: Number(row.tag_count),
      },
    });
  }
  return map;
}

export function completenessForAlbum(albumId) {
  const row = db.prepare(`${AGGREGATE_SQL} WHERE a.id = ? GROUP BY a.id`).get(Number(albumId));
  if (!row) return null;
  const ignored = loadIgnores().get(row.id) ?? new Set();
  const all = missingKeysFor(row);
  const missing = all.filter((k) => !ignored.has(k));
  return {
    albumId: row.id,
    status: statusFor(missing),
    missing,
    missingDetailed: missing.map((k) => ({ key: k, ...MISSING_RULES[k] })),
    ignored: all.filter((k) => ignored.has(k)),
    ignorable: IGNORABLE_KEYS,
  };
}

/** 待完善工作台的汇总：按缺失类型分组计数 */
export function incompleteSummary() {
  const map = completenessMap();
  const groups = new Map(Object.keys(MISSING_RULES).map((key) => [key, 0]));
  let critical = 0;
  let advisory = 0;
  let complete = 0;
  for (const info of map.values()) {
    if (info.status === 'complete') complete += 1;
    else if (info.status === 'critical') critical += 1;
    else advisory += 1;
    for (const key of info.missing) groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return {
    total: map.size,
    complete,
    critical,
    advisory,
    incomplete: critical + advisory,
    groups: [...groups.entries()]
      .map(([key, count]) => ({ key, count, ...MISSING_RULES[key] }))
      .filter((g) => g.count > 0)
      .sort((a, b) => b.count - a.count),
  };
}

/** 待完善专辑清单，可按缺失项筛选 */
export function listIncomplete({ group = null, status = null, limit = 500, offset = 0 } = {}) {
  const map = completenessMap();
  const albums = db.prepare('SELECT * FROM albums').all();
  const rows = [];
  for (const album of albums) {
    const info = map.get(album.id);
    if (!info || info.status === 'complete') continue;
    if (group && !info.missing.includes(group)) continue;
    if (status && info.status !== status) continue;
    rows.push({
      id: album.id,
      album_key: album.album_key,
      album: album.title || '(未知专辑)',
      album_artist: album.album_artist || '(未知艺术家)',
      year: album.year,
      cover_hash: album.cover_hash,
      status: info.status,
      missing: info.missing,
      missingDetailed: info.missingDetailed,
    });
  }
  const order = { critical: 0, advisory: 1 };
  rows.sort((a, b) => (order[a.status] - order[b.status])
    || a.album.localeCompare(b.album, 'zh-Hans-CN'));
  return { total: rows.length, albums: rows.slice(Number(offset), Number(offset) + Number(limit)) };
}

export function ignoreMissing(albumId, key, restore = false) {
  if (!IGNORABLE_KEYS.includes(key)) throw new Error('该项不允许忽略');
  if (restore) {
    db.prepare('DELETE FROM album_ignore WHERE album_id = ? AND key = ?').run(Number(albumId), key);
    return false;
  }
  db.prepare('INSERT OR IGNORE INTO album_ignore (album_id, key, created_at) VALUES (?, ?, ?)')
    .run(Number(albumId), key, Date.now());
  return true;
}
