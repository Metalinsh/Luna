/**
 * Luna 桌面版主进程。
 *
 * 做法：在 Electron 主进程里直接以 ESM 方式加载现有的 Express 服务
 * （server/index.mjs），再用 BrowserWindow 打开本机地址。
 * 这样前后端仍是同一套代码，无需额外进程，也不需要用户机器上装 Node。
 *
 * ⚠ 依赖 Electron 内置 Node ≥ 22.5（本项目用 node:sqlite），
 *   因此 Electron 版本必须 ≥ 35。
 */
const { app, BrowserWindow, shell, Menu, dialog, Tray, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

const isDev = !app.isPackaged;

/** 日志文件：Windows 上 GUI 程序不向父控制台输出，必须落盘才能排查问题 */
let logFile = null;
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a))).join(' ')}`;
  try {
    if (!logFile) {
      const dir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(dir, { recursive: true });
      logFile = path.join(dir, 'luna.log');
    }
    fs.appendFileSync(logFile, `${line}\n`);
  } catch { /* 日志失败不影响运行 */ }
  if (isDev) console.log(line);
}

process.on('uncaughtException', (err) => {
  log('未捕获异常:', err);
  try { dialog.showErrorBox('Luna 发生错误', String(err?.stack ?? err)); } catch { /* 忽略 */ }
});
process.on('unhandledRejection', (err) => log('未处理的 Promise 拒绝:', err));

/**
 * 图标文件查找。三种布局都要覆盖：
 *   1. 开发模式：项目根目录的 build/
 *   2. resources/app/build/  —— build/ 被打进 files 时
 *   3. resources/build/      —— extraResources 拷贝（**发布包走这条**）
 *
 * ⚠ 曾经只找 icon.png 且漏了第 3 条，导致发布版里**一张图标都找不到**，
 *   托盘于是拿到空图 → 任务栏托盘区一个空白图标（v1.2 实测缺陷）。
 */
function iconFile(names = ['icon.png']) {
  const roots = [appRoot(), path.join(__dirname, '..'), process.resourcesPath ?? ''];
  for (const root of roots) {
    for (const name of names) {
      const p = root ? path.join(root, 'build', name) : null;
      try { if (p && fs.existsSync(p)) return p; } catch { /* 忽略 */ }
    }
  }
  return undefined;
}

/**
 * 应用图标。打包后图标已嵌入 exe，但**托盘**必须自己给一张图，
 * 开发模式下窗口图标也需要从磁盘读取。
 */
function appIconPath() {
  return iconFile(['icon.png']);
}

/**
 * 托盘图标：优先多尺寸 ICO（内含 16/24/32…，Windows 会挑最合适的一档，高 DPI 下不糊），
 * 退回 PNG，最后退回 exe 自身图标。
 *
 * 全都拿不到时返回 null —— 宁可让窗口正常关闭，也不要留一个空白图标让用户找不到窗口。
 */
function loadTrayIcon() {
  const file = iconFile(['icon.ico', 'icon.png']);
  if (file) {
    try {
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) {
        return { image: file.endsWith('.ico') ? img : img.resize({ width: 16, height: 16 }), from: file };
      }
      log('托盘图标文件读取为空:', file);
    } catch (err) {
      log('读取托盘图标失败:', err);
    }
  }
  try {
    const fromExe = nativeImage.createFromPath(process.execPath);   // 打包后图标已嵌入 exe
    if (!fromExe.isEmpty()) return { image: fromExe, from: `${process.execPath}（exe 内嵌图标）` };
  } catch { /* 忽略 */ }
  return null;
}

log('=== Luna 主进程启动 ===', {
  electron: process.versions.electron,
  node: process.versions.node,
  packaged: !isDev,
  execPath: process.execPath,
  dirname: __dirname,
  argv: process.argv.slice(1),
});

/**
 * 应用根目录：开发时是项目目录，打包后是 exe 所在目录。
 * 便携版（portable）运行时会被解压到临时目录，真正的 exe 位置由
 * PORTABLE_EXECUTABLE_DIR 给出，必须优先使用它，否则做不到「便携」。
 */
function appRoot() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  return isDev ? path.join(__dirname, '..') : path.dirname(process.execPath);
}

/**
 * 数据目录选择：
 *   1. 环境变量 LAM_DATA_DIR 优先（便于多开/测试）
 *   2. exe（或便携版 exe、项目）同级目录下已有 data/library.db → 用它（便携模式）
 *   3. 否则用系统用户数据目录（%APPDATA%\Luna\data）
 */
function resolveDataDir() {
  if (process.env.LAM_DATA_DIR) return process.env.LAM_DATA_DIR;
  const portable = path.join(appRoot(), 'data');
  if (fs.existsSync(path.join(portable, 'library.db'))) return portable;
  return path.join(app.getPath('userData'), 'data');
}

/**
 * 读取「关闭窗口时最小化到托盘」开关。
 *
 * 设置由渲染层通过 /api/config 写进 data/config.json，主进程在**关闭窗口的那一刻**
 * 现读一次 —— 这样用户在设置里一改就立即生效，不需要重启，也不需要 IPC 同步。
 */
function minimizeToTrayEnabled() {
  try {
    const file = path.join(resolveDataDir(), 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cfg?.desktop?.minimizeToTray === true;
  } catch {
    return false; // 还没写过配置 / 配置坏了 → 保持「关闭即退出」的直觉
  }
}

let tray = null;
/** 真正要退出（而不是收进托盘）时置位，close 事件据此放行 */
let isQuitting = false;

function showMainWindow() {
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 托盘图标：只在真的需要（用户开了开关）时才创建，避免给不需要的人留一个图标 */
function ensureTray() {
  if (tray) return tray;
  const icon = loadTrayIcon();
  if (!icon) {
    log('找不到任何可用图标，放弃创建托盘（开关打开时也不收窗口，避免藏起窗口后找不回来）');
    return null;
  }
  try {
    tray = new Tray(icon.image);
  } catch (err) {
    log('创建托盘失败:', err);
    return null;
  }
  log('托盘已创建，图标来源:', icon.from);
  tray.setToolTip('Luna · 本地音乐与音声库');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: '退出 Luna',
      click: () => { isQuitting = true; app.quit(); },
    },
  ]));
  // 左键单击托盘图标 → 回到窗口（Windows 上习惯用法）
  tray.on('click', () => showMainWindow());
  return tray;
}

/** 找一个可用端口 */
function findFreePort(preferred) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(findFreePort(0)));
    srv.listen(preferred, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 等待服务就绪 */
async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let mainWindow = null;
let serverUrl = null;

async function createWindow() {
  const dataDir = resolveDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.LAM_DATA_DIR = dataDir;
  process.env.HOST = '127.0.0.1';
  log('启动中', { isDev, dataDir, execPath: process.execPath, asar: __dirname.includes('app.asar') });

  const port = await findFreePort(Number(process.env.PORT) || 8799);
  process.env.PORT = String(port);
  serverUrl = `http://127.0.0.1:${port}`;

  // 在主进程内启动现有服务（ESM，动态 import）
  const serverEntry = path.join(__dirname, '..', 'server', 'index.mjs');
  log('加载服务模块:', serverEntry);
  try {
    await import(new URL(`file://${serverEntry.replace(/\\/g, '/')}`).href);
    log('服务模块已加载，监听端口', port);
  } catch (err) {
    log('服务启动失败:', err);
    dialog.showErrorBox('Luna 启动失败', `无法启动本地服务：\n${err?.stack ?? err?.message ?? err}`);
    app.quit();
    return;
  }

  const ready = await waitForServer(serverUrl);
  log('服务就绪检查:', ready, serverUrl);
  if (!ready) {
    dialog.showErrorBox('Luna 启动超时', `本地服务未在预期时间内就绪。\n${serverUrl}`);
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0b0b0f',
    title: 'Luna',
    // 开发模式下也要显示自定义图标（打包后由 electron-builder 写入 exe）
    icon: appIconPath(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // 开关打开时提前把托盘准备好，用户第一次点 × 时才有地方可收
    if (minimizeToTrayEnabled()) ensureTray();
  });
  mainWindow.loadURL(serverUrl);

  /**
   * 关闭按钮的两种语义（设置项「关闭窗口时最小化到托盘」）：
   *   开 → 拦住关闭、只隐藏窗口，应用继续在托盘运行
   *   关 → 正常关闭（随后 window-all-closed 退出整个应用）
   */
  mainWindow.on('close', (e) => {
    if (isQuitting || !minimizeToTrayEnabled()) return;
    // 托盘建不出来就别藏窗口 —— 否则用户只能靠重开 exe 找回来
    if (!ensureTray()) return;
    e.preventDefault();
    mainWindow.hide();
    log('窗口已最小化到托盘');
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // 外部链接交给系统浏览器，不在应用内打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(serverUrl)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

// 单实例：重复启动时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
log('单实例锁:', gotLock);
if (!gotLock) {
  log('已有实例在运行，退出');
  app.quit();
} else {
  app.on('second-instance', () => {
    // 再次启动 exe：把已有窗口叫回来（收进托盘时 focus() 不会显示，必须 show()）
    showMainWindow();
  });

  app.whenReady().then(() => {
    // 去掉默认菜单（保留常用快捷键）
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [{ role: 'quit', label: '退出' }],
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload', label: '刷新' },
          { role: 'forceReload', label: '强制刷新' },
          { type: 'separator' },
          { role: 'resetZoom', label: '实际大小' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '全屏' },
        ],
      },
    ]));
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // 任何退出路径（菜单「退出」、托盘菜单、系统关机）都要放行 close
  app.on('before-quit', () => { isQuitting = true; });
}
