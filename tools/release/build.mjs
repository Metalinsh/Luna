#!/usr/bin/env node
/**
 * Luna 纯净发布脚本。
 *
 * 流程：
 *   1. 前置检查（版本号、图标、工作区状态）
 *   2. 跑完整的测试流程（可用 --skip-tests 跳过，仅限调试）
 *   3. electron-builder 打包便携版
 *   4. **纯净数据**：生成一个全新空库放进 Release/data，
 *      确保发布出去的软件不含开发期的专辑、标签、封面、收藏等记录
 *   5. 校验产物（文件大小、图标、空库）
 *
 * 用法：
 *   node tools/release/build.mjs                 # 打包 + 测试
 *   node tools/release/build.mjs --skip-tests    # 跳过测试（调试用）
 *   node tools/release/build.mjs --no-clean      # 保留 Release 目录里已有的产物
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const RELEASE = path.join(ROOT, 'Release');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const fullVersion = pkg.version;                       // 唯一来源：package.json
/**
 * 产物用**完整版本号**命名（Luna_v1.2.3 / Luna_v1.2.3.zip）。
 *
 * 曾经只取次版本号（1.2.2 → Luna_v1.2），好处是补丁版路径不变，
 * 坏处是补丁版会把上一版的目录与压缩包**原地覆盖**，用户手里两份不同
 * 版本的包无法并存、也看不出自己拿的是哪一版。自 v1.2.3 起改为全版本号。
 */
const appDirName = `Luna_v${fullVersion}`;             // 发布目录名
const zipName = `Luna_v${fullVersion}.zip`;            // 发布压缩包名

const log = (...a) => console.log(...a);
const step = (n, t) => log(`\n${'─'.repeat(70)}\n${n}. ${t}\n${'─'.repeat(70)}`);

function fail(msg) { console.error(`\n✗ ${msg}`); process.exit(1); }

/* ------------------------------------------------------------ 1. 前置检查 */

step(1, '前置检查');
log(`  版本：${fullVersion}（产物名 Luna_v${fullVersion}.exe）`);
if (!fs.existsSync(path.join(ROOT, 'build', 'icon.ico'))) fail('缺少 build/icon.ico，请先运行图标生成。');
if (!fs.existsSync(path.join(ROOT, 'build', 'icon.png'))) fail('缺少 build/icon.png。');
log('  ✓ 图标资源齐备');
if (!fs.existsSync(path.join(ROOT, 'node_modules', 'electron', 'dist'))) {
  fail('缺少 node_modules/electron/dist（electronDist 依赖它）。');
}
log('  ✓ Electron 运行时存在');

/* ------------------------------------------------------------ 2. 完整测试 */

if (has('--skip-tests')) {
  step(2, '完整测试流程 —— 已跳过（--skip-tests）');
  log('  ⚠ 发布前强烈建议跑完整测试：pnpm test:full');
} else {
  step(2, '完整测试流程（发布前必须全绿）');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'check', 'run.mjs'), '--full'], {
    cwd: ROOT, stdio: 'inherit',
  });
  if (r.status !== 0) fail('测试未通过，已中止发布。');
  log('\n  ✓ 完整测试流程通过');
}

/* ------------------------------------------------------------ 3. 清理产物 */

step(3, '清理上一版产物');
fs.mkdirSync(RELEASE, { recursive: true });
if (!has('--no-clean')) {
  // 只清理打包产物；不动用户可能自己放进去的东西
  const targets = ['win-unpacked', 'data', 'builder-debug.yml', 'builder-effective-config.yaml', '.icon-ico'];
  let removed = 0;
  for (const name of targets) {
    const p = path.join(RELEASE, name);
    if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); removed += 1; }
  }
  for (const f of fs.readdirSync(RELEASE)) {
    // 旧产物：Luna_v*.exe / Luna_v*.zip，以及任何 Luna_vX.Y[.Z] 发布目录
    if (/^Luna[_-].*\.(exe|zip)$/i.test(f) || /^Luna_v[\d.]+$/i.test(f)) {
      fs.rmSync(path.join(RELEASE, f), { recursive: true, force: true });
      removed += 1;
    }
  }
  log(`  已清理 ${removed} 项旧产物`);
} else {
  log('  已保留旧产物（--no-clean）');
}

/* ---------------------------------------------------------------- 4. 打包 */

step(4, '打包免安装目录版');
// 直接调用 electron-builder 的 CLI 入口，避免经 .cmd 走 shell（会有 DEP0190 警告）
const builderCli = path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
if (!fs.existsSync(builderCli)) fail(`找不到 electron-builder CLI：${builderCli}`);
const b = spawnSync(process.execPath, [builderCli, '--win', 'dir', '--x64'], {
  cwd: ROOT, stdio: 'inherit',
});
if (b.status !== 0) fail('打包失败。');

// 目录版产物落在 Release/win-unpacked，改名成发布目录名
const appDir = path.join(RELEASE, appDirName);
fs.rmSync(appDir, { recursive: true, force: true });
fs.renameSync(path.join(RELEASE, 'win-unpacked'), appDir);
log(`  ✓ 打包完成 → ${path.relative(ROOT, appDir)}`);

/* ---------------------------------------------------- 5. 纯净数据（关键） */

step(5, '生成纯净数据目录（不含任何开发期记录）');

// 用一个临时目录初始化全新数据库，再把干净的库放进发布目录
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-clean-'));
process.env.LAM_DATA_DIR = tmp;

const store = await import(pathToFileURL(path.join(ROOT, 'server', 'db.mjs')).href);
const counts = {
  albums: store.db.prepare('SELECT COUNT(*) n FROM albums').get().n,
  tracks: store.db.prepare('SELECT COUNT(*) n FROM tracks').get().n,
  tags: store.db.prepare('SELECT COUNT(*) n FROM tags').get().n,
  libraries: store.db.prepare('SELECT COUNT(*) n FROM libraries').get().n,
};
log(`  新库统计：${JSON.stringify(counts)}`);
if (Object.values(counts).some((n) => n !== 0)) {
  fail('新建的库不是空的，拒绝发布。');
}
store.closeDb();

// 数据放在程序目录内：主进程 appRoot() 取 exe 所在目录，即可命中便携模式
const dataDir = path.join(appDir, 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
for (const name of ['library.db', 'library.db-wal', 'library.db-shm', 'backup', 'covers', 'undo']) {
  const src = path.join(tmp, name);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(dataDir, name), { recursive: true });
}
fs.mkdirSync(path.join(dataDir, 'covers', 'thumbs'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'backup'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'undo'), { recursive: true });
fs.rmSync(tmp, { recursive: true, force: true });
log(`  ✓ 已写入纯净库：${path.relative(ROOT, dataDir)}`);

/* ------------------------------------------------------------ 6. 校验产物 */

step(6, '校验产物');
const exe = path.join(appDir, 'Luna.exe');
if (!fs.existsSync(exe)) fail(`未生成 ${path.relative(ROOT, exe)}`);
{
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else bytes += fs.statSync(p).size;
    }
  };
  walk(appDir);
  log(`  ✓ ${path.relative(ROOT, exe)}  目录合计 ${(bytes / 1024 / 1024).toFixed(1)} MB`);
}

// 空库校验（重新打开确认确实没有记录）
const verifyTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-verify-'));
fs.copyFileSync(path.join(dataDir, 'library.db'), path.join(verifyTmp, 'library.db'));
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(verifyTmp, 'library.db'));
  const v = {
    albums: db.prepare('SELECT COUNT(*) n FROM albums').get().n,
    tracks: db.prepare('SELECT COUNT(*) n FROM tracks').get().n,
    tags: db.prepare('SELECT COUNT(*) n FROM tags').get().n,
    libraries: db.prepare('SELECT COUNT(*) n FROM libraries').get().n,
    schema: db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value,
  };
  db.close();
  log(`  ✓ 纯净库校验：${JSON.stringify(v)}`);
  if (Object.entries(v).some(([k, n]) => k !== 'schema' && n !== 0)) fail('发布包里的库不是空库！');
  if (!v.schema) fail('发布包的库缺少 schema_version。');
}
fs.rmSync(verifyTmp, { recursive: true, force: true });

/* ------------------------------------------------------------ 7. 压缩包 */

step(7, '生成发布压缩包');
const zipPath = path.join(RELEASE, zipName);
fs.rmSync(zipPath, { force: true });
// Windows 10+ 自带 bsdtar，比 Compress-Archive 快很多
const t = spawnSync('tar', ['-a', '-c', '-f', zipPath, appDirName], {
  cwd: RELEASE, stdio: 'inherit',
});
if (t.status !== 0 || !fs.existsSync(zipPath)) {
  log('  ⚠ tar 打包失败，回退到 Compress-Archive');
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${path.join(RELEASE, appDirName)}' -DestinationPath '${zipPath}' -Force`],
  { cwd: RELEASE, stdio: 'inherit' });
  if (ps.status !== 0 || !fs.existsSync(zipPath)) fail('压缩包生成失败。');
}
log(`  ✓ ${zipName}  ${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB`);

log('\n' + '═'.repeat(70));
log(`Luna v${fullVersion} 发布完成`);
log('═'.repeat(70));
log(`  程序目录：${path.relative(ROOT, appDir)}`);
log(`  发布压缩包：${path.relative(ROOT, zipPath)}`);
log(`  数据目录：${path.relative(ROOT, dataDir)}（全新空库，首次启动即为干净状态）`);
log('\n  使用方式：解压压缩包到任意位置，双击 Luna.exe 即可；');
log('            数据保存在程序目录下的 data/，整个文件夹可随 U 盘携带。');
log('            删除 data/ 则退回使用 %APPDATA%\\luna-media-library\\data。');;
