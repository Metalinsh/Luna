#!/usr/bin/env node
/**
 * Luna 纯净发布脚本。
 *
 * 流程：
 *   1. 前置检查（版本号、图标、工作区状态）
 *   2. 跑测试（默认**只跑相对上一版有改动的区域**；--full-tests 才跑完整流程）
 *   3. electron-builder 打包便携版
 *   4. **纯净数据**：生成一个全新空库放进 Release/data，
 *      确保发布出去的软件不含开发期的专辑、标签、封面、收藏等记录
 *   5. 校验产物（文件大小、图标、空库）
 *
 * 用法：
 *   node tools/release/build.mjs                 # 打包 + 只测改动区域（默认）
 *   node tools/release/build.mjs --full-tests    # 打包 + 完整测试流程（用户明确要求时才用）
 *   node tools/release/build.mjs --skip-tests    # 跳过测试（调试用）
 *   node tools/release/build.mjs --no-clean      # 保留 Release 目录里已有的产物
 *
 * 测试范围的规则（2026-10-11 与用户约定）：
 *   · 发布默认只验证「相对上一个发布标签有改动」的功能区域 —— 靠 `run.mjs --changed --since=<上一版标签>`
 *     按 manifest 的文件覆盖表自动挑区域，没改动的功能不重复跑。
 *   · **只有用户明确要求**时才跑完整测试（--full-tests）。跑之前先按 docs/测试流程.md §4.4
 *     检查一遍测试内容、剔除重复项，再开跑。
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

/* ------------------------------------------------------------ 2. 测试 */

/**
 * 上一个发布标签：`git tag` 里版本号最大的 `Luna-v*`，排除本次要发的版本。
 * 用它做 `--since` 基准，就能得到「相对上一版有改动」的文件集合。
 */
function previousReleaseTag(currentVersion) {
  const r = spawnSync('git', ['tag', '--list', 'Luna-v*', '--sort=-v:refname'], {
    cwd: ROOT, encoding: 'utf8',
  });
  if (r.status !== 0) return null;
  const tags = String(r.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  return tags.find((t) => t !== `Luna-v${currentVersion}`) ?? null;
}

if (has('--skip-tests')) {
  step(2, '测试流程 —— 已跳过（--skip-tests）');
  log('  ⚠ 仅限调试：正式发布不要跳过');
} else if (has('--full-tests')) {
  // 用户明确要求时才跑：跑之前先按 docs/测试流程.md §4.4 复核一遍测试内容、剔除重复项
  step(2, '完整测试流程（--full-tests：用户明确要求）');
  log('  ⚠ 提醒：跑完整流程前应先复核测试内容、剔除重复项（docs/测试流程.md §4.4）');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'check', 'run.mjs'), '--full'], {
    cwd: ROOT, stdio: 'inherit',
  });
  if (r.status !== 0) fail('测试未通过，已中止发布。');
  log('\n  ✓ 完整测试流程通过');
} else {
  const prevTag = previousReleaseTag(fullVersion);
  /*
   * 自动判定是**文件级**的：改动一旦落在公共文件（public/app.js、styles.css）上，
   * 映射出来的区域会接近全量，达不到"只测改动功能"的目的。
   * 因此支持 --areas=<列表> 由人按**本次真正改动的功能**明确指定（推荐）。
   */
  const areasArg = argv.find((a) => a.startsWith('--areas='))?.slice('--areas='.length);
  if (areasArg) {
    step(2, `指定区域测试（--areas=${areasArg}）`);
    const r = spawnSync(process.execPath,
      [path.join(ROOT, 'tools', 'check', 'run.mjs'), `--area=${areasArg}`], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) fail('指定区域的测试未通过，已中止发布。');
    log('\n  ✓ 指定区域测试通过');
    log('    需要全面回归时：node tools/release/build.mjs --full-tests');
  } else {
    step(2, prevTag ? `按改动测试（相对上一版 ${prevTag}）` : '按改动测试（未找到上一版标签，退回"相对工作区改动"）');
    const args = [path.join(ROOT, 'tools', 'check', 'run.mjs'), '--changed'];
    if (prevTag) args.push(`--since=${prevTag}`);
    const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) fail('改动区域的测试未通过，已中止发布。');
    log('\n  ✓ 改动区域测试通过（未改动的功能按约定不重复跑）');
    log('    改动集中在公共文件、自动范围过宽时，用 --areas=区域1,区域2 明确指定');
    log('    需要全面回归时：node tools/release/build.mjs --full-tests');
  }
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

/**
 * 优先用 **Windows 自带的 bsdtar**（`%SystemRoot%\System32\tar.exe`，libarchive）。
 *
 * ⚠ 不能直接用 PATH 上的 `tar`：多数环境里它是 **GNU tar**，而 GNU tar **不会写 zip** ——
 *   `-a` 只认 gz/bz2/xz 等后缀，给它 `.zip` 既不报错也不压缩，直接产出**改了名的 tar**，
 *   而退出码仍是 0（实测：产物头是 `sub/` 而不是 `PK\x03\x04`）。
 *   另外绝对路径里的盘符会被它当成「远程主机:路径」（`tar: Cannot connect to E:`）。
 *   两者叠加的结果就是：要么白跑一趟再回退，要么**静默发出一个假 zip**。
 *
 * 因此这里固定用 bsdtar 的绝对路径，并且打包后**校验 ZIP 魔数**，不信任退出码。
 */
const BSDTAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

/** 真 ZIP 以 'PK' 开头（bsdtar/GNU tar 的 tar 头则是文件名，绝不会是 PK） */
function isRealZip(p) {
  try {
    const fd = fs.openSync(p, 'r');
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    return head[0] === 0x50 && head[1] === 0x4b;
  } catch { return false; }
}

/** 回退：PowerShell 的 Compress-Archive（慢，但一定是真 ZIP） */
function zipWithCompressArchive() {
  fs.rmSync(zipPath, { force: true });   // 清掉可能留下的假 zip
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${path.join(RELEASE, appDirName)}' -DestinationPath '${zipPath}' -Force`],
  { cwd: RELEASE, stdio: 'inherit' });
  return ps.status === 0 && fs.existsSync(zipPath) && isRealZip(zipPath);
}

let zipped = false;
if (fs.existsSync(BSDTAR)) {
  // -f 传相对名即可（cwd 已是 RELEASE），顺带避开盘符解析问题
  const t = spawnSync(BSDTAR, ['-a', '-c', '-f', zipName, appDirName], {
    cwd: RELEASE, stdio: 'inherit',
  });
  zipped = t.status === 0 && isRealZip(zipPath);
  if (!zipped) log('  ⚠ bsdtar 未成功产出 ZIP，回退到 Compress-Archive');
} else {
  log(`  ⚠ 未找到 Windows 自带 tar（${BSDTAR}），回退到 Compress-Archive`);
}

if (!zipped && !zipWithCompressArchive()) fail('压缩包生成失败。');
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
