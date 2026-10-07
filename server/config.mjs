import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const PUBLIC_DIR = path.join(ROOT, 'public');

/**
 * 应用版本：**唯一来源是 package.json**。
 * 启动日志、/api/health、打包产物名都从这里取，避免多处硬编码互相漂移。
 */
export const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return String(pkg.version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
})();
/** 数据目录：测试可通过 LAM_DATA_DIR 重定向到临时目录 */
export const DATA_DIR = process.env.LAM_DATA_DIR
  ? path.resolve(process.env.LAM_DATA_DIR)
  : path.join(ROOT, 'data');
export const COVER_DIR = path.join(DATA_DIR, 'covers');
export const THUMB_DIR = path.join(COVER_DIR, 'thumbs');
export const BACKUP_DIR = path.join(DATA_DIR, 'backup');
export const UNDO_DIR = path.join(DATA_DIR, 'undo');
export const DB_FILE = path.join(DATA_DIR, 'library.db');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULT_CONFIG = {
  port: 8787,
  host: '127.0.0.1',
  coverSize: 'medium',
  playMode: 'list-loop',
  search: { ftsThreshold: 20000 },
  backup: { location: 'near-library', keepJobs: 3, maxSizeGb: 30 },
};

/** 写操作备份目录名（放在音乐库根目录下，保证与源文件同卷，rename 零拷贝） */
export const UNDO_DIR_NAME = '.lam-undo';

export function ensureDirs() {
  for (const dir of [DATA_DIR, COVER_DIR, THUMB_DIR, BACKUP_DIR, UNDO_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function libraryUndoDir(libraryRoot) {
  return path.join(libraryRoot, UNDO_DIR_NAME);
}

export function readConfig() {
  ensureDirs();
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  ensureDirs();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** 统一的专辑分组键：优先 albumartist，无专辑标签时按所在目录归组 */
export function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function albumKeyOf({ album, albumArtist, artist, dir }) {
  const a = normalizeText(album);
  if (!a) return `dir\u0000${String(dir ?? '').toLowerCase()}`;
  const who = normalizeText(albumArtist) || normalizeText(artist);
  return `alb\u0000${who.toLowerCase()}\u0000${a.toLowerCase()}`;
}

export function encodeKey(key) {
  return Buffer.from(String(key), 'utf8').toString('base64url');
}

export function decodeKey(token) {
  try {
    return Buffer.from(String(token), 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.m4a', '.mp4', '.m4b', '.aac', '.ogg', '.oga',
  '.opus', '.wav', '.aiff', '.aif', '.aifc', '.wma', '.ape', '.wv',
  '.dsf', '.dff', '.mpc', '.tak',
]);

export const MIME_BY_EXT = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.aifc': 'audio/aiff',
  '.wma': 'audio/x-ms-wma',
  '.ape': 'audio/x-ape',
  '.wv': 'audio/x-wavpack',
  '.dsf': 'audio/x-dsf',
  '.dff': 'audio/x-dff',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};
