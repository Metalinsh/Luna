/**
 * 桌面歌词窗口（v1.2.7）。
 *
 * 和 desktop-dialog.mjs 同一个套路：服务端跑在 Electron 主进程里，所以这里能直接
 * `new BrowserWindow(...)`，不需要 preload / IPC，也不需要改 electron/main.cjs。
 *
 * 歌词窗口是一个**独立轻量页面**（public/desktop-lyrics.html），
 * 只负责显示；播放状态由主窗口通过同源 BroadcastChannel 广播过来。
 *
 * 纯 Node（`pnpm start` / 单元测试）下 `isAvailable()` 返回 false，接口回 409，
 * 前端提示「仅桌面版支持」。
 */
import { createRequire } from 'node:module';
import { readConfig, writeConfig } from './config.mjs';

/** undefined = 未探测；null = 不可用；对象 = Electron API */
let cached;
let lyricsWindow = null;
let locked = false;
let saveTimer = null;

function electronApi() {
  if (cached !== undefined) return cached;
  cached = null;
  if (!process.versions.electron) return cached;
  try {
    const electron = createRequire(import.meta.url)('electron');
    if (typeof electron?.BrowserWindow === 'function' && electron?.screen) cached = electron;
  } catch {
    cached = null;
  }
  return cached;
}

/** 当前进程能否开桌面歌词窗口 */
export function isAvailable() {
  return Boolean(electronApi());
}

export function status() {
  const config = readConfig().desktopLyrics;
  const open = Boolean(lyricsWindow && !lyricsWindow.isDestroyed());
  return {
    available: isAvailable(),
    open,
    locked: open ? locked : false,
    bounds: open ? lyricsWindow.getBounds() : null,
    config,
  };
}

/**
 * 保存窗口位置/大小（拖动/缩放后 400ms 合并写一次，避免频繁落盘）。
 * 只在窗口还活着时写；关闭时不覆盖已保存的位置。
 */
function schedulePersistBounds() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!lyricsWindow || lyricsWindow.isDestroyed()) return;
    const b = lyricsWindow.getBounds();
    try {
      writeConfig({ desktopLyrics: { x: b.x, y: b.y, width: b.width, height: b.height } });
    } catch { /* 配置写失败不影响窗口 */ }
  }, 400);
  saveTimer.unref?.();
}

function bottomCenter(electron, width, height) {
  const wa = electron.screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + wa.height - height - 48),
    width,
    height,
  };
}

/**
 * 恢复上次位置时做一次可见性校正：
 * 显示器拔掉/分辨率变化后，原来的坐标可能落在屏幕外，此时回到底部居中。
 */
function visibleBounds(electron, { x, y, width, height }) {
  const workAreas = electron.screen.getAllDisplays().map((d) => d.workArea);
  const intersects = workAreas.some((a) => (
    x < a.x + a.width - 80
    && x + width > a.x + 80
    && y < a.y + a.height - 40
    && y + height > a.y
  ));
  return intersects ? { x, y, width, height } : bottomCenter(electron, width, height);
}

/** 打开（已打开则只提到最前，不重复创建） */
export function open(serverUrl) {
  const electron = electronApi();
  if (!electron) return { ok: false, error: '桌面歌词仅桌面版支持' };
  if (!serverUrl) return { ok: false, error: '本地服务地址尚未就绪' };

  const { BrowserWindow } = electron;
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.showInactive();
    return { ok: true, ...status() };
  }

  const cfg = readConfig().desktopLyrics;
  const width = cfg.width;
  const height = cfg.height;
  const hasSaved = Number.isFinite(cfg.x) && Number.isFinite(cfg.y);
  const bounds = hasSaved
    ? visibleBounds(electron, { x: cfg.x, y: cfg.y, width, height })
    : bottomCenter(electron, width, height);

  lyricsWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'Luna 桌面歌词',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  locked = false;
  lyricsWindow.setAlwaysOnTop(true, 'screen-saver');
  lyricsWindow.loadURL(`${serverUrl}/desktop-lyrics.html`);
  // 不抢主窗口焦点：用户正在别的软件里操作时也不打断
  lyricsWindow.once('ready-to-show', () => lyricsWindow?.showInactive());
  lyricsWindow.on('moved', schedulePersistBounds);
  lyricsWindow.on('resized', schedulePersistBounds);
  lyricsWindow.on('closed', () => {
    lyricsWindow = null;
    locked = false;
    try { writeConfig({ desktopLyrics: { enabled: false, locked: false } }); } catch { /* 忽略 */ }
  });

  // 主窗口关闭时一并收掉：否则只剩歌词窗口，window-all-closed 不会触发、进程退不掉
  const mainWindow = BrowserWindow.getAllWindows().find((w) => w !== lyricsWindow);
  mainWindow?.once('closed', () => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.close();
  });

  try { writeConfig({ desktopLyrics: { enabled: true, locked: false } }); } catch { /* 忽略 */ }
  return { ok: true, ...status() };
}

export function close() {
  if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.close();
  lyricsWindow = null;
  locked = false;
  try { writeConfig({ desktopLyrics: { enabled: false, locked: false } }); } catch { /* 忽略 */ }
  return { ok: true, ...status() };
}

/** 锁定 = 鼠标穿透（点不到歌词窗）；解锁后恢复交互 */
export function setLocked(next) {
  if (!lyricsWindow || lyricsWindow.isDestroyed()) {
    return { ok: false, error: '桌面歌词未打开' };
  }
  locked = Boolean(next);
  // forward: true —— 锁定期间仍把鼠标移动事件转给窗口，悬停效果不至于完全卡死
  lyricsWindow.setIgnoreMouseEvents(locked, { forward: true });
  try { writeConfig({ desktopLyrics: { locked } }); } catch { /* 忽略 */ }
  return { ok: true, ...status() };
}

/** 字号 / 透明度等显示设置：只写配置，窗口侧通过返回结果就地更新 */
export function updateSettings(patch = {}) {
  const next = writeConfig({ desktopLyrics: patch });
  return { ok: true, ...status(), config: next.desktopLyrics };
}
