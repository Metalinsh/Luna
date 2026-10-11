/**
 * 专辑图片画廊（**只读**）。
 *
 * 用途：专辑详情页「图片预览」栏目 —— 展示专辑文件夹 / 压缩包里的图片，
 * 按图片所在文件夹分组，点缩略图看原图。
 *
 * 两个来源：
 *   · 压缩包发行：成员清单直接查 `archive_members`（扫描时已登记 `kind='image'`，不碰包文件）
 *   · 磁盘发行：在发行根 / 曲目目录内递归查找（深度与数量都有上限）
 *
 * 安全：取图一律「先能列出、才能取到」——
 * 压缩包按 `member_path` 精确匹配，磁盘按「必须落在该专辑的根目录内」校验，
 * 因此 `?p=` 参数无法穿越到专辑目录之外。
 *
 * 与音声三层模型的关系：图片**不是轨道**，不参与版本判定
 * （见 asmr.mjs 的 analyzeRelease：只有 audio / video 进轨道模型）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import * as store from './db.mjs';
import * as zip from './zip-reader.mjs';

/** 图片扩展名（与 zip-reader 的 IMAGE_EXT 保持一致） */
export const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};

/** 单次列出的图片数量上限（防御性：极端目录不再拖慢详情页） */
const MAX_IMAGES = 300;
/** 磁盘递归深度上限 */
const MAX_DEPTH = 4;
/** 压缩包内单张图片的解出上限：超过则拒绝预览，避免把内存打满 */
const MAX_MEMBER_BYTES = 64 * 1024 * 1024;

const SKIP_DIRS = new Set([
  'node_modules', '$recycle.bin', 'system volume information',
  '.lam-undo', 'luna_cache',
]);

const naturalByName = (a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true });

export function isImageName(name) {
  return IMAGE_EXT.has(path.extname(String(name)).toLowerCase());
}

export function imageMime(name) {
  return MIME_BY_EXT[path.extname(String(name)).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 该专辑的图片来源根。
 * 音声发行用 `release_root`（目录或 .zip）；普通专辑退回「各曲目所在目录」。
 */
export function albumImageRoots(album, tracks) {
  const root = String(album?.release_root ?? '').trim();
  if (root) return [root];
  const dirs = [];
  for (const t of tracks ?? []) {
    const dir = String(t?.dir ?? '').trim();
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

/** 音声发行的发行根是压缩包时，取它的登记信息；否则返回 null（按磁盘目录处理） */
function archiveOf(album) {
  const root = String(album?.release_root ?? '').trim();
  if (!root || !zip.isArchiveName(root)) return null;
  return store.getArchiveByPath(root);
}

/** 磁盘：在 root 下递归收集图片（跳过隐藏目录与系统目录，深度/数量都有上限） */
function walkImages(root, out, state, depth = 0) {
  if (depth > MAX_DEPTH || state.truncated) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (state.truncated) return;
    if (entry.name.startsWith('.')) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      walkImages(full, out, state, depth + 1);
      continue;
    }
    if (!entry.isFile() || !isImageName(entry.name)) continue;
    if (out.length >= MAX_IMAGES) { state.truncated = true; return; }
    let size = 0;
    try { size = fs.statSync(full).size; } catch { /* 取不到大小不影响展示 */ }
    out.push({ key: full, name: entry.name, size, source: 'disk', scanRoot: root });
  }
}

function relDirOf(filePath, scanRoot) {
  const rel = path.relative(scanRoot, path.dirname(filePath));
  if (!rel || rel === '.') return '';
  return rel.split(path.sep).join('/');
}

/**
 * 列出专辑内的图片，并按所在文件夹分组。
 *
 * @returns {{
 *   images: Array<{ index:number, key:string, name:string, dir:string, group:string,
 *                   size:number, source:'disk'|'archive', url:string }>,
 *   groups: Array<{ label:string, indices:number[] }>,
 *   truncated: boolean,
 *   source: 'archive'|'disk'|'none'
 * }}
 */
export function listAlbumImages(album, tracks) {
  const archive = archiveOf(album);
  const raw = [];
  let truncated = false;
  let source = 'none';

  if (archive) {
    source = 'archive';
    for (const m of store.listArchiveMembers(archive.id, 'image')) {
      if (raw.length >= MAX_IMAGES) { truncated = true; break; }
      const rel = String(m.member_path).replace(/\\/g, '/');
      const dir = path.posix.dirname(rel);
      raw.push({
        key: rel,
        name: path.posix.basename(rel),
        dir: dir === '.' ? '' : dir,
        group: dir === '.' ? '根目录' : dir,
        size: m.size ?? 0,
        source: 'archive',
      });
    }
  } else {
    const scanRoots = albumImageRoots(album, tracks);
    if (scanRoots.length) source = 'disk';
    const multiple = scanRoots.length > 1;
    const state = { truncated: false };
    for (const root of scanRoots) {
      const found = [];
      walkImages(root, found, state);
      const room = MAX_IMAGES - raw.length;
      if (found.length > room) { truncated = true; }
      for (const f of found.slice(0, Math.max(room, 0))) {
        const dir = relDirOf(f.key, root);
        const prefix = multiple ? `${path.basename(root)}/` : '';
        raw.push({
          key: f.key,
          name: f.name,
          dir,
          group: `${prefix}${dir || '根目录'}`,
          size: f.size,
          source: 'disk',
        });
      }
      if (state.truncated || truncated) break;
    }
  }

  // 组内按文件名自然序；组间：根目录优先，其余按标签排序
  const byGroup = new Map();
  for (const item of raw) {
    if (!byGroup.has(item.group)) byGroup.set(item.group, []);
    byGroup.get(item.group).push(item);
  }
  const labels = [...byGroup.keys()].sort((a, b) => {
    const aRoot = a.endsWith('根目录') ? 0 : 1;
    const bRoot = b.endsWith('根目录') ? 0 : 1;
    return aRoot !== bRoot ? aRoot - bRoot : a.localeCompare(b, 'zh');
  });

  const images = [];
  const groups = [];
  for (const label of labels) {
    const list = byGroup.get(label).sort(naturalByName);
    const indices = [];
    for (const item of list) {
      indices.push(images.length);
      images.push({
        ...item,
        index: images.length,
        url: `/api/albums/${album.id}/image?p=${encodeURIComponent(item.key)}`,
      });
    }
    groups.push({ label, indices });
  }

  return { images, groups, truncated, source };
}

/**
 * 按 key 取出**原图**。
 *
 * @returns {Promise<null | { filePath?:string, data?:Buffer, mime:string, size:number, tooLarge?:boolean }>}
 */
export async function resolveAlbumImage(album, tracks, key) {
  const wanted = String(key ?? '');
  if (!wanted) return null;

  const archive = archiveOf(album);
  if (archive) {
    const rel = wanted.replace(/\\/g, '/').replace(/^\/+/, '');
    const row = store.listArchiveMembers(archive.id, 'image')
      .find((m) => String(m.member_path).replace(/\\/g, '/') === rel);
    if (!row) return null;
    if (Number(row.size) > MAX_MEMBER_BYTES) {
      return { mime: imageMime(row.member_path), size: Number(row.size), tooLarge: true };
    }
    const member = await zip.readMember(archive.path, row.member_path);
    return { data: member.data, mime: imageMime(row.member_path), size: member.data.length };
  }

  const abs = path.resolve(wanted);
  if (!isImageName(abs)) return null;
  const roots = albumImageRoots(album, tracks).map((r) => path.resolve(r));
  const inside = roots.some((r) => abs === r || abs.startsWith(r.endsWith(path.sep) ? r : `${r}${path.sep}`));
  if (!inside) return null;

  const st = await fsp.stat(abs).catch(() => null);
  if (!st?.isFile()) return null;
  return { filePath: abs, mime: imageMime(abs), size: st.size };
}
