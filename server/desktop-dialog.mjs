/**
 * 桌面版原生对话框（Electron）桥接。
 *
 * 为什么能这样写：Luna 的服务端（server/index.mjs）是**在主进程里**被动态 import 的
 * （见 electron/main.cjs），所以它可以越过渲染进程直接调用 Electron 的 `dialog`，
 * 不需要 preload、不需要 IPC、前端零改动。
 *
 * 两条铁律：
 *   1. 不能在文件顶部 `import ... from 'electron'` —— 纯 Node（`pnpm start`、单元测试、
 *      浏览器模式）下会直接抛错，整个服务起不来；
 *   2. 纯 Node 下 `nativeDialogAvailable()` 必须老老实实返回 false，由调用方退回
 *      PowerShell 选择框（见 server/index.mjs 的 PICK_FOLDER_SCRIPT）。
 */
import { createRequire } from 'node:module';

/** undefined = 还没探测过；null = 探测过，不可用；对象 = Electron API */
let cached;

function electronApi() {
  if (cached !== undefined) return cached;
  cached = null;
  if (!process.versions.electron) return cached;

  try {
    // 打包后 require('electron') 走 Electron 内建模块，不依赖 node_modules
    const electron = createRequire(import.meta.url)('electron');
    if (typeof electron?.dialog?.showOpenDialog === 'function') cached = electron;
  } catch {
    cached = null;
  }
  return cached;
}

/** 当前进程能否使用 Electron 原生对话框 */
export function nativeDialogAvailable() {
  return Boolean(electronApi());
}

/**
 * 弹出系统原生选择框。
 *
 * @param {Electron.OpenDialogOptions} options
 * @returns {Promise<{canceled: boolean, filePaths: string[]} | null>}
 *          null 表示当前不是 Electron 环境，调用方应走 PowerShell 兜底
 */
export async function showNativeDialog(options) {
  const electron = electronApi();
  if (!electron) return null;

  const { BrowserWindow } = electron;
  // 挂到当前窗口才是模态的；窗口还没建好（或已销毁）时退回无父窗口的调用
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  const result = parent
    ? await electron.dialog.showOpenDialog(parent, options)
    : await electron.dialog.showOpenDialog(options);

  return {
    canceled: Boolean(result?.canceled),
    filePaths: Array.isArray(result?.filePaths) ? result.filePaths : [],
  };
}
