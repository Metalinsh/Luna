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
const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
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
 * 应用图标。打包后图标已嵌入 exe，但开发模式与任务栏仍需要从磁盘读取。
 * 优先用 256px 的 PNG，缺失时退回 exe 自带的图标。
 */
function appIconPath() {
  const candidates = [
    path.join(appRoot(), 'build', 'icon.png'),
    path.join(__dirname, '..', 'build', 'icon.png'),
    path.join(process.resourcesPath ?? '', 'build', 'icon.png'),
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* 忽略 */ }
  }
  return undefined;
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

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(serverUrl);
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
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
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
}
