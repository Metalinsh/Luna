/**
 * 用户输入路径的规范化与可达性检查（Windows）。
 *
 * 背景（v1.2.7）：NAS 用户添加映射盘里的目录时报「目录不存在或不可访问：ENOENT」，
 * 同时看到文件夹名乱码。根因是「浏览…」用 PowerShell 取路径、按系统代码页（cp936）
 * 输出、Node 按 UTF-8 解码 —— 非 ASCII 路径必然变成 `�`，拿它去 stat 自然 ENOENT。
 *
 * 本模块只做三件事，不碰任何数据库：
 *   1. `normalizeUserPath()`  把用户粘贴/选择来的路径收敛成唯一形态，并拒绝明显坏值；
 *   2. `statDirectory()` / `probeReadable()`  对网络盘做一次短重试与可读性探测；
 *   3. `describePathError()`  把 errno 翻译成能照做的中文提示（ENOENT 不再只有四个字母）。
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 复制路径时常见的不可见字符（零宽、BOM、方向控制符） */
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
/** 外层引号：中英文单双引号都算 */
const WRAPPING_QUOTES = /^[\s"'“”‘’]+|[\s"'“”‘’]+$/g;
/** UTF-8 解码失败留下的替换字符 */
const REPLACEMENT_CHAR = /\uFFFD/;
/** 网络盘常见的瞬时错误：值得再试一次（NAS 唤醒 / SMB 重连） */
const TRANSIENT_CODES = new Set(['ENOENT', 'UNKNOWN', 'ENOTCONN', 'ETIMEDOUT', 'EBUSY']);

/**
 * 规范化用户给出的路径。
 *
 * @param {unknown} raw 输入框或对话框返回的原始值
 * @returns {{ok: true, path: string} | {ok: false, error: string}}
 */
export function normalizeUserPath(raw) {
  let p = String(raw ?? '').replace(INVISIBLE_CHARS, '').trim();
  p = p.replace(WRAPPING_QUOTES, '').trim();

  if (!p) return { ok: false, error: '缺少目录路径' };

  // 乱码是「选目录」链路里最典型的坏值：直接拒绝，别让它变成一条 ENOENT
  if (REPLACEMENT_CHAR.test(p)) {
    return {
      ok: false,
      error: '路径包含无法识别的字符（编码转换失败，通常显示为 �）。请点「浏览…」重新选择，或直接手动粘贴完整路径。',
    };
  }

  // 正斜杠在 Windows 上等价于反斜杠；顺带把 //NAS/share 变成 \\NAS\share
  p = p.replace(/\//g, '\\');
  p = p.replace(/%([^%]+)%/g, (match, name) => {
    const value = process.env[name] ?? process.env[name.toUpperCase()];
    return value ?? match;
  });

  if (p === '~' || p.startsWith('~\\')) {
    p = path.win32.join(os.homedir(), p.slice(1));
  }

  // \\?\ 前缀（长路径 / UNC）原样保留：normalize 会把它当根，不会破坏
  p = path.win32.normalize(p);

  if (!path.win32.isAbsolute(p)) {
    return {
      ok: false,
      error: `请填写完整路径：${p}。应以盘符开头（如 E:\\Music）或 UNC 共享开头（如 \\\\NAS\\共享名\\目录）。`,
    };
  }

  // 去掉末尾多余的分隔符，但根目录（C:\、\\NAS\share\）保留
  const root = path.win32.parse(p).root;
  if (p.length > root.length) p = p.replace(/\\+$/, '');

  return { ok: true, path: p };
}

/**
 * 把对话框拿到的「Base64(UTF-8)」还原成路径。
 *
 * 之所以用 Base64：Windows PowerShell 5.1 在 stdout 被重定向时按
 * `[Console]::OutputEncoding`（简中系统是 cp936）写字节，Node 却按 UTF-8 解码，
 * 中文 / 日文路径必然损坏。Base64 全是 ASCII，与系统语言和 chcp 完全无关。
 *
 * @param {unknown} output PowerShell 的 stdout
 * @returns {string} 解码后的路径；空输出返回空串；不是 Base64 时原样返回
 */
export function decodePickedPath(output) {
  const text = String(output ?? '').trim();
  if (!text) return '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return text;
  return Buffer.from(text, 'base64').toString('utf8');
}

/**
 * stat 一个目录，网络盘的瞬时错误自动重试一次。
 *
 * @param {string} target 已规范化的绝对路径
 * @param {{attempts?: number, delayMs?: number}} [options]
 * @returns {Promise<import('node:fs').Stats>}
 */
export async function statDirectory(target, { attempts = 2, delayMs = 250 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fsp.stat(target);
    } catch (err) {
      lastError = err;
      const retryable = TRANSIENT_CODES.has(err?.code);
      if (!retryable || i === attempts - 1) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/**
 * 探测目录能否被列出来（「看得见、读不了」在 NAS 共享上很常见）。
 *
 * @param {string} target
 * @returns {Promise<{ok: true} | {ok: false, error: Error}>}
 */
export async function probeReadable(target) {
  let dir;
  try {
    dir = await fsp.opendir(target);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err };
  } finally {
    if (dir) await dir.close().catch(() => {});
  }
}

/**
 * 目录自检：存在 + 是目录 + 能列出。
 *
 * @param {string} target
 * @returns {Promise<{ok: true} | {ok: false, message: string}>}
 */
export async function checkDirectory(target) {
  let stat;
  try {
    stat = await statDirectory(target);
  } catch (err) {
    return { ok: false, message: describePathError(err, target) };
  }
  if (!stat.isDirectory()) return { ok: false, message: `路径不是目录：${target}` };

  const readable = await probeReadable(target);
  if (!readable.ok) return { ok: false, message: describePathError(readable.error, target) };
  return { ok: true };
}

/**
 * 把文件系统错误翻译成可执行的中文提示。
 *
 * @param {NodeJS.ErrnoException | undefined} err
 * @param {string} target 已规范化的路径（会原样展示，方便用户核对）
 * @returns {string}
 */
export function describePathError(err, target) {
  const code = err?.code ?? 'UNKNOWN';
  switch (code) {
    case 'ENOENT':
      return `目录不存在或不可访问：${target}（ENOENT）。请依次确认：① 路径没有选错、没有乱码；② 若是 NAS 映射盘符，Luna 当前会话可能看不到这个映射（以管理员身份运行时看不到当前用户的映射盘）—— 可改填 UNC 路径，如 \\\\NAS\\共享名\\目录；③ NAS 休眠或网络未就绪，点「添加并扫描」前先在资源管理器打开一次该目录。`;
    case 'EACCES':
    case 'EPERM':
      return `没有访问权限：${target}（${code}）。请检查 NAS 的共享权限与该共享的登录凭据；仍不行时可在资源管理器里用同一账号打开一次。`;
    case 'ENOTCONN':
    case 'EHOSTDOWN':
    case 'ETIMEDOUT':
    case 'ENETUNREACH':
    case 'UNKNOWN':
      return `网络路径暂时不可访问：${target}（${code}）。请确认 NAS 在线、共享已登录，然后重试。`;
    case 'EBUSY':
      return `目录正被占用或设备忙：${target}（EBUSY）。请稍后重试。`;
    default:
      return `目录不可访问：${target}（${code}）。`;
  }
}
