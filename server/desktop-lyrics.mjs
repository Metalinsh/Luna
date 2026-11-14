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
/** 锁定（鼠标穿透）状态下光标是否压在歌词上：由页面喂上来，供 status() 回读 */
let hoverInside = false;
/** 锁定状态下主进程轮询光标（页面收不到 mousemove），变化时才通知页面 */
let hoverProbe = null;

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
    hover: open ? hoverInside : false,
    bounds: open ? lyricsWindow.getBounds() : null,
    config,
  };
}

/** 把光标在不在歌词上的状态记下来（页面用 mousemove / mouseleave 上报，不占后台轮询） */
export function setHover(inside) {
  hoverInside = Boolean(inside);
  return { ok: true };
}

/** 把主窗口叫到前台（歌词工具条上的 ♪ 按钮） */
export function focusMain() {
  const electron = electronApi();
  if (!electron) return { ok: false, error: '桌面歌词仅桌面版支持' };
  const main = electron.BrowserWindow.getAllWindows().find((w) => w !== lyricsWindow && !w.isDestroyed());
  if (!main) return { ok: false, error: '主窗口已关闭' };
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
  return { ok: true };
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
  lastServerUrl = serverUrl;

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
    /*
     * 浮层不需要键盘焦点：一旦它拿到焦点又失焦，Windows 上的透明无边框窗
     * 会「冒出」一条系统标题栏并一直留着（Electron #46882 / #47440）。
     * 不聚焦就从根上避开 blur 分支；鼠标点击、拖动仍然正常。
     */
    focusable: false,
    title: 'Luna 桌面歌词',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  locked = false;
  hoverInside = false;
  lyricsWindow.setAlwaysOnTop(true, 'screen-saver');
  /*
   * 锁定后整个窗口都是鼠标穿透的，点不到任何按钮 —— 所以必须留一个键盘出口。
   * 用全局快捷键（不需要窗口聚焦）切换锁定，和主窗口那个「桌面歌词」按钮互补。
   */
  try {
    electron.globalShortcut.register('Control+Alt+L', () => {
      if (lyricsWindow && !lyricsWindow.isDestroyed()) setLocked(!locked);
    });
    // 白条冒出来时的手动修复：销毁重建，一秒内干净
    electron.globalShortcut.register('Control+Alt+R', () => rebuild('手动修复'));
  } catch { /* 快捷键被别的程序占用就算了，不影响主流程 */ }
  lyricsWindow.loadURL(`${serverUrl}/desktop-lyrics.html`);
  // 不抢主窗口焦点：用户正在别的软件里操作时也不打断
  lyricsWindow.once('ready-to-show', () => lyricsWindow?.showInactive());
  lyricsWindow.on('moved', schedulePersistBounds);
  lyricsWindow.on('resized', schedulePersistBounds);
  /*
   * 白条（系统标题栏）的兜底：Windows 会在窗口失焦 / 样式位变化时给透明无边框窗
   * 补一条不透明的标题栏，且没有任何窗口级 API 能查出来、也收不回去。
   * 唯一可靠的办法是「销毁重建」——重建出来的窗口一定没有那条栏。
   * 挂在主窗口失焦上：用户切走的那一刻重建，等于是拿一次不可见的闪断换掉白条。
   */
  const owner = BrowserWindow.getAllWindows().find((w) => w !== lyricsWindow);
  owner?.on('blur', scheduleCaptionFix);
  // 重建时会先 close 旧的再开新的：closed 是异步回来的，别让它把新窗口的引用清掉
  const me = lyricsWindow;
  me.on('closed', () => {
    if (lyricsWindow !== me) return;
    lyricsWindow = null;
    locked = false;
    hoverInside = false;
    try { electron.globalShortcut.unregister('Control+Alt+L'); } catch { /* 忽略 */ }
    try { writeConfig({ desktopLyrics: { enabled: false, locked: false } }); } catch { /* 忽略 */ }
  });

  // 主窗口关闭时一并收掉：否则只剩歌词窗口，window-all-closed 不会触发、进程退不掉
  const mainWindow = BrowserWindow.getAllWindows().find((w) => w !== lyricsWindow);
  mainWindow?.once('closed', () => {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.close();
  });

  try { writeConfig({ desktopLyrics: { enabled: true, locked: false } }); } catch { /* 忽略 */ }
  startHoverProbe();
  return { ok: true, ...status() };
}


function stopHoverProbe() {
  if (hoverProbe) {
    clearInterval(hoverProbe);
    hoverProbe = null;
  }
}

/**
 * 锁定后窗口是鼠标穿透的，Chromium 收不到 mousemove，CSS :hover 也就永远不会亮。
 * 这里用主进程 150ms 轮询光标位置，只在「进/出」发生变化时 executeJavaScript 通知页面，
 * 页面侧 window.__dlHover 打上 data-hover，仍然不需要 preload / IPC。
 */
function startHoverProbe() {
  stopHoverProbe();
  const e = electronApi();
  if (!e || !e.screen) return;
  hoverProbe = setInterval(() => {
    if (!lyricsWindow || lyricsWindow.isDestroyed()) {
      stopHoverProbe();
      return;
    }
    let inside = false;
    let pt = null;
    let b = null;
    try {
      pt = e.screen.getCursorScreenPoint();
      b = lyricsWindow.getBounds();
      inside = pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height;
    } catch { /* 忽略 */ }
    if (inside === hoverInside) return;
    hoverInside = inside;
    lyricsWindow.webContents
      .executeJavaScript(`window.__dlHover && window.__dlHover(${inside})`)
      .catch(() => {});
  }, 150);
}

export function close() {
  if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.close();
  lyricsWindow = null;
  locked = false;
  hoverInside = false;
  stopHoverProbe();
  try { electronApi()?.globalShortcut.unregister('Control+Alt+L'); } catch { /* 忽略 */ }
  try { electronApi()?.globalShortcut.unregister('Control+Alt+R'); } catch { /* 忽略 */ }
  try { writeConfig({ desktopLyrics: { enabled: false, locked: false } }); } catch { /* 忽略 */ }
  return { ok: true, ...status() };
}

/** 锁定 = 鼠标穿透（点不到歌词窗）；解锁后恢复交互 */
export function setLocked(next) {
  if (!lyricsWindow || lyricsWindow.isDestroyed()) {
    return { ok: false, error: '桌面歌词未打开' };
  }
  locked = Boolean(next);
  if (!locked) hoverInside = false;
  startHoverProbe();
  // forward: true —— 锁定期间仍把鼠标移动事件转给窗口，悬停效果不至于完全卡死
  lyricsWindow.setIgnoreMouseEvents(locked, { forward: true });
  /*
   * 注意：这里**不要**动 setResizable / setMaximizable / setMinimizable。
   * 每改一次样式位，Windows 都会重新计算非客户区，透明无边框窗就会冒出一条
   * 系统标题栏（Electron #46882）。窗口创建时设好就不再碰，白条才不出现。
   */
  try { writeConfig({ desktopLyrics: { locked } }); } catch { /* 忽略 */ }
  return { ok: true, ...status() };
}

/** 记住最近一次的服务地址，重建窗口时要用 */
let lastServerUrl = null;

/** 重建：销毁再创建，位置/尺寸/锁定状态都沿用当前值 */
export function rebuild(reason = '手动修复') {
  if (!lyricsWindow || lyricsWindow.isDestroyed()) {
    return { ok: false, error: '桌面歌词未打开' };
  }
  const url = lastServerUrl;
  if (!url) return { ok: false, error: '服务地址缺失' };
  const b = lyricsWindow.getBounds();
  const wasLocked = locked;
  console.log('[桌面歌词] 重建窗口:', reason);
  const old = lyricsWindow;
  // 先摘掉引用：旧窗口的 closed 回调看到 me !== lyricsWindow 就什么都不做
  lyricsWindow = null;
  locked = false;
  hoverInside = false;
  try { old.destroy(); } catch { /* 忽略 */ }
  try { electronApi()?.globalShortcut.unregister('Control+Alt+L'); } catch { /* 忽略 */ }
  try { electronApi()?.globalShortcut.unregister('Control+Alt+R'); } catch { /* 忽略 */ }
  /*
   * 等一帧再建：同一 tick 里销毁+创建，Windows 有时会把新窗口也按旧窗的样式位建出来，
   * 白条就又跟着回来了。
   */
  setTimeout(() => {
    if (lyricsWindow) return;
    const result = open(url);
    if (result.ok === false) return;
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      lyricsWindow.setBounds(b);
      if (wasLocked) setLocked(true);
    }
  }, 120);
  return { ok: true, pending: true };
}

/**
 * 主窗口失焦后延迟一点重建（让用户切走时看到的是干净窗口），
 * 1.2 秒内只做一次，避免 Alt+Tab 连按时反复重建。
 */
let captionFixAt = 0;
function scheduleCaptionFix() {
  const now = Date.now();
  if (now - captionFixAt < 1200) return;
  captionFixAt = now;
  setTimeout(() => {
    if (!lyricsWindow || lyricsWindow.isDestroyed()) return;
    /*
     * 光标正在歌词窗上时不要重建：那多半是用户点了歌词窗（它不抢焦点，主窗口会
     * 跟着失焦），这时候把窗口销毁重建，等于把用户正在拖的东西抽走。
     */
    try {
      const pt = electronApi()?.screen.getCursorScreenPoint();
      const b = lyricsWindow.getBounds();
      if (pt && pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height) return;
    } catch { /* 取不到光标就照常重建 */ }
    rebuild('主窗失去焦点');
  }, 180);
}

/** 拖动结束后把尺寸钉回原值：移动透明无边框窗时 Windows 会顺手 +1~2px */
export function fixSize({ width, height } = {}) {
  if (!lyricsWindow || lyricsWindow.isDestroyed()) return { ok: false };
  const w = Math.max(320, Math.round(Number(width) || 0));
  const h = Math.max(110, Math.round(Number(height) || 0));
  if (!w || !h) return { ok: false };
  const b = lyricsWindow.getBounds();
  lyricsWindow.setBounds({ x: b.x, y: b.y, width: w, height: h });
  schedulePersistBounds();
  return { ok: true, ...status() };
}

/**
 * 右键菜单：用系统原生弹出菜单，贴着鼠标弹、点外面自动收。
 * 页面里画面板会挡住歌词本身，调字号/颜色时看不到变化，所以走主进程 Menu。
 */
/**
 * 右键菜单独立成一个「小弹窗」，而不是在歌词窗里画面板：
 * 歌词窗只有 150px 高，任何竖排菜单都放不下；盖在歌词上又看不到调色的效果。
 * 这里开一个透明的无边框小窗贴在光标旁边，点外面（失去焦点）自动收。
 */
let menuWindow = null;

export function closeMenu() {
  if (menuWindow && !menuWindow.isDestroyed()) menuWindow.close();
  menuWindow = null;
  return { ok: true };
}

export function openMenu() {
  const e = electronApi();
  if (!e || !lyricsWindow || lyricsWindow.isDestroyed() || !lastServerUrl) return { ok: false };
  const { BrowserWindow, screen } = e;

  if (menuWindow && !menuWindow.isDestroyed()) { menuWindow.close(); menuWindow = null; }

  const W = 208;
  const H = 250;
  const pt = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(pt).workArea;
  const x = Math.min(Math.max(pt.x - 6, area.x + 4), area.x + area.width - W - 4);
  const y = Math.min(Math.max(pt.y - 6, area.y + 4), area.y + area.height - H - 4);

  menuWindow = new BrowserWindow({
    x,
    y,
    width: W,
    height: H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  menuWindow.setAlwaysOnTop(true, 'screen-saver');
  menuWindow.loadURL(`${lastServerUrl}/desktop-lyrics-menu.html`);
  menuWindow.once('ready-to-show', () => menuWindow?.show());
  menuWindow.on('blur', () => closeMenu());
  menuWindow.on('closed', () => { menuWindow = null; });
  return { ok: true };
}

/** 让歌词页重新读一遍配置（改完设置/预览后调用） */
export function refreshPage() {
  if (!lyricsWindow || lyricsWindow.isDestroyed()) return { ok: false };
  lyricsWindow.webContents
    .executeJavaScript('window.__dlRefresh && window.__dlRefresh()')
    .catch(() => {});
  return { ok: true };
}

/** 悬停预览：只改画面，不落盘（离开菜单项就还原） */
export function previewSettings(patch = {}) {
  if (!lyricsWindow || lyricsWindow.isDestroyed()) return { ok: false };
  const safe = JSON.stringify({
    fontScale: Number(patch.fontScale) || undefined,
    opacity: patch.opacity === undefined ? undefined : Number(patch.opacity),
    color: typeof patch.color === 'string' ? patch.color : undefined,
    outline: ['strong', 'soft', 'off'].includes(patch.outline) ? patch.outline : undefined,
  });
  lyricsWindow.webContents
    .executeJavaScript(`window.__dlPreview && window.__dlPreview(${safe})`)
    .catch(() => {});
  return { ok: true };
}

/** 字号 / 透明度等显示设置：只写配置，窗口侧通过返回结果就地更新 */
export function updateSettings(patch = {}) {
  const next = writeConfig({ desktopLyrics: patch });
  return { ok: true, ...status(), config: next.desktopLyrics };
}
