#!/usr/bin/env node
/**
 * Luna 测试运行器 —— 分级测试流程的统一入口。
 *
 * 用法：
 *   node tools/check/run.mjs --changed          # 局部：按 git 改动自动挑区域（日常开发）
 *   node tools/check/run.mjs --area=lyrics      # 局部：只跑指定区域（可逗号分隔多个）
 *   node tools/check/run.mjs --unit             # 只跑单元测试（最快）
 *   node tools/check/run.mjs --full             # 完整：所有区域（发布前必跑）
 *   node tools/check/run.mjs --list             # 列出所有区域
 *
 * 其它选项：
 *   --since=<ref>   以某个 git 引用为基准判断改动（默认 HEAD，未提交改动优先）
 *   --no-app        不自动启动 Electron（假定已有实例在跑）
 *   --keep-app      跑完不关闭自己启动的实例
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { AREAS, APP, NO_APP_AREAS, areaById, areasForFiles } from './manifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

/* ------------------------------------------------------------------ 参数 */

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

if (has('--help') || has('-h')) {
  console.log(await import('node:fs').then((fs) => fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'))
    .split('\n').slice(1, 18).map((l) => l.replace(/^\/?\*+ ?/, '')).join('\n'));
  process.exit(0);
}

if (has('--list')) {
  console.log('\n可用测试区域：\n');
  for (const a of AREAS) {
    const parts = [];
    if (a.unitAuto || a.unit.length) parts.push('单元测试');
    if (a.ui.length) parts.push(`${a.ui.length} 个界面脚本`);
    console.log(`  ${a.id.padEnd(9)} ${a.title.padEnd(14)} ${a.desc}`);
    console.log(`  ${''.padEnd(9)} 包含：${parts.join(' + ')}${a.app ? '（需启动软件）' : ''}`);
    console.log('');
  }
  process.exit(0);
}

/* ------------------------------------------------------------ 决定跑哪些 */

function gitLines(args) {
  return new Promise((resolve) => {
    const p = spawn('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve([]));
    p.on('close', () => resolve(out.split('\n').map((s) => s.trim()).filter(Boolean)));
  });
}

/** 收集「本次改动」涉及的文件：优先未提交改动，其次最近一次提交 */
async function changedFiles(since) {
  const files = new Set();
  if (since) {
    for (const f of await gitLines(['diff', '--name-only', since])) files.add(f);
    return [...files];
  }
  // 用三条精确命令代替 porcelain 解析，避免状态位截断文件名
  // （porcelain 的 "XY path" 前缀在某些状态下会多吞一个字符）
  for (const args of [
    ['diff', '--name-only'],                    // 未暂存的修改
    ['diff', '--name-only', '--cached'],        // 已暂存的修改
    ['ls-files', '--others', '--exclude-standard'], // 新增未跟踪文件
    ['diff', '--name-only', 'HEAD'],            // 兜底：相对 HEAD 的全部改动
  ]) {
    for (const f of await gitLines(args)) files.add(f);
  }
  if (files.size === 0) {
    for (const f of await gitLines(['diff', '--name-only', 'HEAD~1'])) files.add(f);
  }
  return [...files];
}

let selected = [];
let mode = '';

const areaArg = valueOf('area');
if (areaArg) {
  selected = areaArg.split(',').map((s) => s.trim()).filter(Boolean);
  mode = '指定区域';
} else if (has('--full')) {
  selected = AREAS.map((a) => a.id);
  mode = '完整流程';
} else if (has('--unit')) {
  selected = ['unit'];
  mode = '仅单元测试';
} else if (has('--changed')) {
  const files = await changedFiles(valueOf('since'));
  selected = areasForFiles(files);
  mode = '按改动自动选择';
  console.log(`\n检测到 ${files.length} 个改动文件`);
  if (files.length && files.length <= 25) for (const f of files) console.log(`  · ${f}`);
  else if (files.length) console.log(`  （${files.slice(0, 12).join(', ')} …）`);
} else {
  console.log('未指定模式。常用：--changed（局部） / --full（发布前完整） / --list');
  process.exit(1);
}

const unknown = selected.filter((id) => !areaById(id));
if (unknown.length) {
  console.error(`未知区域：${unknown.join(', ')}。用 --list 查看可用区域。`);
  process.exit(1);
}

if (!selected.length) {
  console.log('\n改动未命中任何测试区域（可能只改了文档或工具脚本）—— 无需运行测试。');
  process.exit(0);
}

const picked = selected.map(areaById);
console.log(`\n运行模式：${mode}`);
console.log(`选中区域（${picked.length}）：${picked.map((a) => `${a.id}(${a.title})`).join('、')}`);

/* -------------------------------------------------------------- 启动软件 */

const needApp = picked.some((a) => a.app);
let appProc = null;

async function reachable(url, timeoutMs = 1500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

async function ensureApp() {
  if (!needApp || has('--no-app')) return;
  if (await reachable(`${APP.apiBase}/api/health`) && await reachable(`http://127.0.0.1:${APP.cdpPort}/json/list`)) {
    console.log('已检测到运行中的开发实例，直接复用。');
    return;
  }
  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (!existsSync(electron)) {
    console.error('找不到 Electron，可执行文件缺失：' + electron);
    process.exit(1);
  }
  console.log('启动 Electron 开发实例…');
  const env = { ...process.env, PORT: '8799' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.LAM_DATA_DIR;
  appProc = spawn(electron, ['.', `--remote-debugging-port=${APP.cdpPort}`], {
    cwd: ROOT, env, detached: false, stdio: 'ignore',
  });
  appProc.unref?.();
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await reachable(`${APP.apiBase}/api/health`)
      && await reachable(`http://127.0.0.1:${APP.cdpPort}/json/list`)) {
      console.log('开发实例就绪。\n');
      return;
    }
  }
  console.error('开发实例未在 40 秒内就绪，界面检查将失败。');
}

function run(cmd, args, label) {
  return new Promise((resolve) => {
    console.log(`\n${'─'.repeat(72)}\n▶ ${label}\n${'─'.repeat(72)}`);
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    p.on('error', () => resolve({ ok: false, code: -1 }));
    p.on('close', (code) => resolve({ ok: code === 0, code }));
  });
}

/* ------------------------------------------------------------------ 执行 */

await ensureApp();

const results = [];
for (const area of picked) {
  if (area.unitAuto || area.unit.length) {
    // unitAuto：不加路径，让 node --test 自动发现 test/ 下的用例
    const targets = area.unitAuto ? [] : [...area.unit];
    const r = await run(process.execPath, ['--test', ...targets], `[${area.id}] ${area.title} · 单元测试`);
    results.push({ area, kind: 'unit', ...r });
  }
  for (const script of area.ui) {
    const abs = path.join(ROOT, 'tools', script);
    if (!existsSync(abs)) {
      results.push({ area, kind: script, ok: false, code: -1, missing: true });
      continue;
    }
    const r = await run(process.execPath, [abs], `[${area.id}] ${area.title} · ${script}`);
    results.push({ area, kind: script, ...r });
  }
}

if (appProc && !has('--keep-app')) {
  try { appProc.kill(); } catch { /* 忽略 */ }
  console.log('\n已关闭本次启动的开发实例。');
}

/* ------------------------------------------------------------------ 汇总 */

console.log(`\n${'═'.repeat(72)}\n测试汇总（${mode}）\n${'═'.repeat(72)}`);
const byArea = new Map();
for (const r of results) {
  if (!byArea.has(r.area.id)) byArea.set(r.area.id, []);
  byArea.get(r.area.id).push(r);
}
let failed = 0;
for (const area of picked) {
  const rs = byArea.get(area.id) ?? [];
  const bad = rs.filter((r) => !r.ok);
  failed += bad.length;
  const mark = bad.length ? '✗ 失败' : '✓ 通过';
  console.log(`  ${mark}  ${area.title.padEnd(14)} ${rs.length} 个检查项`
    + (bad.length ? `  ← ${bad.map((b) => b.kind).join(', ')}` : ''));
}
console.log(`\n总计：${results.length} 个检查项，失败 ${failed} 个`);

if (failed) {
  console.log('\n局部测试提示：修复后重跑同样的命令即可；提交前建议 --changed 全绿。');
  process.exit(1);
}
if (mode === '完整流程') {
  console.log('\n完整测试流程通过，可以进入打包发布。');
} else {
  console.log('\n局部测试通过。发布前请再跑一次 --full 完整流程。');
}
process.exit(0);
