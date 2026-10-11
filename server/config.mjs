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

/**
 * 应用根目录：开发时是项目目录，打包后是 exe 所在目录。
 * 与 DATA_DIR 区分：DATA_DIR 是「数据库与封面」，本值是「程序自身所在」。
 * 便携版运行时会被解压到临时目录，真正的 exe 位置由 PORTABLE_EXECUTABLE_DIR 给出。
 */
export const APP_ROOT = process.env.PORTABLE_EXECUTABLE_DIR
  ? path.resolve(process.env.PORTABLE_EXECUTABLE_DIR)
  : ROOT;

/** 压缩包按需解码的缓存目录名（默认在应用根目录下） */
export const CACHE_DIR_NAME = 'luna_cache';

/**
 * 缓存目录默认值：**应用根目录**下的 luna_cache/。
 * 与 DATA_DIR 的区别：缓存可能很大（几十 GB），跟 exe 走才不会污染系统盘。
 * 用户可在设置界面改成任意目录。
 */
export const DEFAULT_CACHE_DIR = path.join(APP_ROOT, CACHE_DIR_NAME);

const DEFAULT_CONFIG = {
  port: 8787,
  host: '127.0.0.1',
  coverSize: 'medium',
  playMode: 'list-loop',
  search: { ftsThreshold: 20000 },
  backup: { location: 'near-library', keepJobs: 3, maxSizeGb: 30 },
  /** 压缩包（P2）：预取策略与缓存上限 */
  archive: {
    /** off = 不预读取；next = 仅预读取下一首；album = 预读取专辑 */
    prefetch: 'next',
    cacheDir: DEFAULT_CACHE_DIR,
    /** 允许占用的缓存上限（字节），默认 20 GiB */
    maxBytes: 20 * 1024 ** 3,
  },
  /** 桌面外壳行为（由 Electron 主进程读取，见 electron/main.cjs） */
  desktop: {
    /** 关闭窗口时最小化到托盘，而不是退出（默认关：保持「点 × 就退出」的直觉） */
    minimizeToTray: false,
  },
  /** 外观：配色方案、深浅模式、背景透明、自定义背景图 */
  appearance: {
    theme: 'midnight',
    /** dark | light —— 浅色模式会整体翻转底色与文字色 */
    mode: 'dark',
    /** 0–100：数值越大，界面底色越不透明 */
    bgOpacity: 100,
    /** 自定义背景图（绝对路径或 data URL），null 表示无 */
    bgImage: null,
  },
};

const PREFETCH_MODES = new Set(['off', 'next', 'album']);
const THEMES = new Set(['midnight', 'nebula', 'graphite']);
const MODES = new Set(['dark', 'light']);

/** 配置值归一化：越界或非法的输入一律退回默认，避免坏配置把界面弄坏 */
function sanitize(cfg) {
  const d = DEFAULT_CONFIG;
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

  /** 背景图路径：data URL 原样保留；本地路径去掉重复的反斜杠 */
  const cleanImagePath = (v) => {
    if (!v) return null;
    const s = String(v).trim();
    if (!s) return null;
    if (/^data:/i.test(s)) return s;
    return s.replace(/\\{2,}/g, '\\');
  };

  const archive = { ...d.archive, ...(cfg.archive ?? {}) };
  if (!PREFETCH_MODES.has(archive.prefetch)) archive.prefetch = d.archive.prefetch;
  archive.cacheDir = String(archive.cacheDir ?? '').trim() || d.archive.cacheDir;
  // 上限：不小于 512 MiB，避免用户填个极小值让功能完全不可用
  archive.maxBytes = Math.max(512 * 1024 ** 2, num(archive.maxBytes, d.archive.maxBytes));

  const appearance = { ...d.appearance, ...(cfg.appearance ?? {}) };
  if (!THEMES.has(appearance.theme)) appearance.theme = d.appearance.theme;
  if (!MODES.has(appearance.mode)) appearance.mode = d.appearance.mode;
  appearance.bgOpacity = Math.min(100, Math.max(0, num(appearance.bgOpacity, 100)));
  appearance.bgImage = cleanImagePath(appearance.bgImage);

  const desktop = { ...d.desktop, ...(cfg.desktop ?? {}) };
  desktop.minimizeToTray = desktop.minimizeToTray === true;

  return {
    ...d, ...cfg, search: { ...d.search, ...(cfg.search ?? {}) },
    backup: { ...d.backup, ...(cfg.backup ?? {}) }, archive, appearance, desktop,
  };
}

export { PREFETCH_MODES, THEMES, MODES };

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
    return sanitize({ ...DEFAULT_CONFIG, ...JSON.parse(raw) });
  } catch {
    return sanitize({ ...DEFAULT_CONFIG });
  }
}

/** 实际生效的缓存目录（校验用户填的值，非法则回退默认） */
export function resolveCacheDir(cfg = readConfig()) {
  const raw = String(cfg?.archive?.cacheDir ?? '').trim();
  if (!raw) return DEFAULT_CACHE_DIR;
  try {
    return path.resolve(raw);
  } catch {
    return DEFAULT_CACHE_DIR;
  }
}

/**
 * 写入配置（**嵌套对象按段合并**，避免只传一个子字段就把整段覆盖掉）。
 * 写入前统一 sanitize，因此磁盘上不会出现越界或非法的值。
 */
export function writeConfig(patch = {}) {
  const current = readConfig();
  const merged = { ...current, ...patch };
  for (const key of ['search', 'backup', 'archive', 'appearance', 'desktop']) {
    if (patch[key] && typeof patch[key] === 'object') {
      merged[key] = { ...current[key], ...patch[key] };
    }
  }
  const next = sanitize(merged);
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
