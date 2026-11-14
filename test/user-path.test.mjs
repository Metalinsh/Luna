/**
 * 用户路径规范化与「选目录」编码修复（v1.2.7）。
 *
 * 背景：NAS 用户添加映射盘目录时报「目录不存在或不可访问：ENOENT」，且文件夹名乱码。
 * 根因是 PowerShell 5.1 按系统代码页（cp936）写 stdout、Node 按 UTF-8 解码。
 * 修复后：路径经 Base64 传输，并统一走 normalizeUserPath / checkDirectory 自检。
 *
 * 这些用例不启动软件、不碰真实音乐库；只在 os.tmpdir() 里验证可达性检查。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  normalizeUserPath, decodePickedPath, checkDirectory, describePathError, statDirectory,
} from '../server/user-path.mjs';

/* ------------------------------------------------------------- 规范化 */

test('路径：去首尾空白与中英文引号', () => {
  assert.deepEqual(normalizeUserPath('  "E:\\Music\\Album"  '), { ok: true, path: 'E:\\Music\\Album' });
  assert.deepEqual(normalizeUserPath('“E:\\Music”'), { ok: true, path: 'E:\\Music' });
  assert.deepEqual(normalizeUserPath("'E:\\Music'"), { ok: true, path: 'E:\\Music' });
});

test('路径：末尾多余分隔符去掉，盘符根保留', () => {
  assert.deepEqual(normalizeUserPath('E:\\Music\\Album\\\\'), { ok: true, path: 'E:\\Music\\Album' });
  assert.deepEqual(normalizeUserPath('D:\\'), { ok: true, path: 'D:\\' });
});

test('路径：正斜杠与 UNC 共享都能识别', () => {
  // 用户从别处粘贴 //NAS/share/... 也要能用
  assert.deepEqual(normalizeUserPath('//NAS/share/音声/作品'), { ok: true, path: '\\\\NAS\\share\\音声\\作品' });
  assert.deepEqual(normalizeUserPath('\\\\NAS\\share\\音声'), { ok: true, path: '\\\\NAS\\share\\音声' });
  assert.deepEqual(normalizeUserPath('C:/Music/Album'), { ok: true, path: 'C:\\Music\\Album' });
});

test('路径：%VAR% 环境变量展开', () => {
  process.env.LUNA_TEST_MUSIC = 'E:\\Music';
  assert.deepEqual(normalizeUserPath('%LUNA_TEST_MUSIC%\\音声'), { ok: true, path: 'E:\\Music\\音声' });
});

test('路径：去掉复制路径时常带进来的零宽字符与 BOM', () => {
  assert.deepEqual(normalizeUserPath('E:\\\u200BMusic\uFEFF\\Album'), { ok: true, path: 'E:\\Music\\Album' });
});

test('路径：相对路径被拒绝并给出示例', () => {
  const r = normalizeUserPath('Music\\Album');
  assert.equal(r.ok, false);
  assert.match(r.error, /完整路径/);
  assert.match(r.error, /UNC/);
});

test('路径：空值被拒绝', () => {
  assert.deepEqual(normalizeUserPath('   '), { ok: false, error: '缺少目录路径' });
});

test('路径：含 U+FFFD 的乱码直接拒绝（不再变成 ENOENT）', () => {
  const r = normalizeUserPath('E:\\LunaNAS\uFFFD\uFFFD\\音声');
  assert.equal(r.ok, false);
  assert.match(r.error, /编码转换失败/);
});

/* --------------------------------------------------- 对话框输出解码 */

test('解码：Base64(UTF-8) 的中文路径可以完整还原', () => {
  const real = 'E:\\测试\\音声\\RJ123456';
  const b64 = Buffer.from(real, 'utf8').toString('base64');
  assert.equal(decodePickedPath(b64), real);
});

test('解码：空输出表示用户取消', () => {
  assert.equal(decodePickedPath(''), '');
  assert.equal(decodePickedPath('   \r\n'), '');
});

test('解码：不是 Base64 的输出原样返回（兼容旧脚本）', () => {
  assert.equal(decodePickedPath('E:\\Music'), 'E:\\Music');
});

test('PowerShell：经 Base64 传回的中文路径不丢字符', { skip: process.platform !== 'win32' }, async (t) => {
  const real = 'E:\\测试\\音声\\RJ123456';
  // 与 server/index.mjs 的 PICK_FOLDER_SCRIPT 同一套路：脚本用 UTF-16LE Base64 传入
  const script = `[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('${real}')))`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const run = (exe) => new Promise((resolve, reject) => {
    execFile(exe, ['-NoProfile', '-STA', '-EncodedCommand', encoded], { timeout: 30000, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout ?? ''))));
  });

  let out;
  try {
    out = await run('powershell.exe');
  } catch {
    out = await run('pwsh.exe');
  }
  assert.equal(decodePickedPath(out), real);
});

/* ------------------------------------------------------- 可达性检查 */

test('自检：真实目录通过', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-user-path-'));
  try {
    assert.deepEqual(await checkDirectory(dir), { ok: true });
    const st = await statDirectory(dir);
    assert.equal(st.isDirectory(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('自检：不存在的目录给出含路径与排查步骤的提示', async () => {
  const missing = path.join(os.tmpdir(), `luna-missing-${Date.now()}`, '音声');
  const r = await checkDirectory(missing);
  assert.equal(r.ok, false);
  assert.ok(r.message.includes(missing), '提示里要带完整路径');
  assert.match(r.message, /ENOENT/);
  assert.match(r.message, /管理员/);
  assert.match(r.message, /UNC/);
});

test('自检：文件不是目录', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-user-path-'));
  const file = path.join(dir, 'cover.jpg');
  fs.writeFileSync(file, 'x');
  try {
    const r = await checkDirectory(file);
    assert.equal(r.ok, false);
    assert.match(r.message, /不是目录/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------- 错误文案 */

test('文案：ENOENT / EACCES / UNKNOWN 分别给出对应排查方向', () => {
  assert.match(describePathError({ code: 'ENOENT' }, 'Z:\\Music'), /映射盘|UNC/);
  assert.match(describePathError({ code: 'EACCES' }, 'Z:\\Music'), /权限|凭据/);
  assert.match(describePathError({ code: 'UNKNOWN' }, '\\\\NAS\\share'), /网络路径/);
  assert.match(describePathError(undefined, 'Z:\\Music'), /不可访问/);
});
