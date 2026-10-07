/**
 * 标签写入适配器（设计文档 5.3.2）。
 *
 * 选型：node-taglib-sharp（纯 JS，无原生编译），统一覆盖 MP3/FLAC/M4A/OGG/Opus/WAV/AIFF/WMA/APE。
 * 本模块只负责「把一批字段就地写进给定的文件」——备份、原子替换、校验与撤销
 * 都在 write-jobs.mjs 里完成，这里不做任何安全决策。
 */
import fs from 'node:fs';

import {
  File as TagFile, Picture, PictureType, ByteVector,
} from 'node-taglib-sharp';

/** taglib 支持写入的扩展名 */
export const WRITABLE_EXTENSIONS = new Set([
  '.mp3', '.flac', '.m4a', '.m4b', '.mp4', '.aac',
  '.ogg', '.oga', '.opus', '.wav', '.aiff', '.aif', '.aifc', '.wma', '.ape',
]);

export function canWrite(ext) {
  return WRITABLE_EXTENSIONS.has(String(ext ?? '').toLowerCase());
}

/** 支持的写入字段（也是 API 允许的 patch 键） */
export const WRITABLE_FIELDS = [
  'title', 'album', 'albumArtist', 'artists', 'trackNo', 'discNo',
  'year', 'genres', 'composers', 'comment', 'picture',
];

export function describeWriteSupport() {
  return {
    writer: 'node-taglib-sharp',
    license: 'LGPL-2.1-or-later',
    extensions: [...WRITABLE_EXTENSIONS],
    fields: WRITABLE_FIELDS,
  };
}

const asArray = (value) => (Array.isArray(value) ? value.filter((v) => v != null && v !== '') : []);

/**
 * 就地写入标签。patch 中未出现的键一律不动；显式传 null/'' 表示清空该字段。
 * picture：{ data: Buffer, mimeType: string, description?: string } 或 null（移除全部图片）。
 * 返回实际写入的字段名数组。
 */
export function writeTags(filePath, patch = {}) {
  if (!fs.existsSync(filePath)) throw new Error('文件不存在');
  const applied = [];
  const file = TagFile.createFromPath(filePath);
  try {
    const tag = file.tag;

    if ('title' in patch) { tag.title = patch.title ?? ''; applied.push('title'); }
    if ('album' in patch) { tag.album = patch.album ?? ''; applied.push('album'); }

    if ('albumArtist' in patch) {
      tag.albumArtists = patch.albumArtist ? [String(patch.albumArtist)] : [];
      applied.push('albumArtist');
    }
    if ('artists' in patch) {
      tag.performers = asArray(patch.artists).map(String);
      applied.push('artists');
    }
    if ('trackNo' in patch) {
      const n = Number(patch.trackNo);
      tag.track = Number.isFinite(n) && n > 0 ? n : 0;
      applied.push('trackNo');
    }
    if ('discNo' in patch) {
      const n = Number(patch.discNo);
      tag.disc = Number.isFinite(n) && n > 0 ? n : 0;
      applied.push('discNo');
    }
    if ('year' in patch) {
      const y = Number(patch.year);
      tag.year = Number.isFinite(y) && y > 0 ? y : 0;
      applied.push('year');
    }
    if ('genres' in patch) {
      tag.genres = asArray(patch.genres).map(String);
      applied.push('genres');
    }
    if ('composers' in patch) {
      tag.composers = asArray(patch.composers).map(String);
      applied.push('composers');
    }
    if ('comment' in patch) {
      tag.comment = patch.comment ?? '';
      applied.push('comment');
    }
    if ('picture' in patch) {
      if (patch.picture?.data?.length) {
        tag.pictures = [pictureFromBuffer(patch.picture)];
      } else {
        tag.pictures = [];
      }
      applied.push('picture');
    }

    file.save();
    file.dispose();
    return applied;
  } catch (err) {
    try { file.dispose(); } catch { /* 忽略 */ }
    throw err;
  }
}

function pictureFromBuffer({ data, mimeType = 'image/jpeg', description = 'front' }) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const type = PictureType?.FrontCover ?? 3;
  return Picture.fromFullData(ByteVector.fromByteArray(buffer), type, mimeType, description);
}
