#!/usr/bin/env node
/**
 * 测试内容审计 —— 全面回归（`--full`）**之前**先跑这个。
 *
 * 规则（2026-10-11 与用户约定）：每次运行全面测试前，先检查一遍测试内容、
 * 去除重复项，再开跑。手工通读 15 个检查脚本 + 12 个单元测试文件不现实，
 * 所以把"找重复"机械化：
 *
 *   1. UI 断言层：把 `ok('…')` 的标签归一化（去数字/标点/大小写），
 *      找出**同一标签在多个区域重复出现**的组；
 *   2. 单元测试层：同样做名字归一化，找跨文件同名用例；
 *   3. 主题分布：按关键词看哪些区域在覆盖同一主题（人工判断是否冗余）；
 *   4. 段落清单：打印每个检查脚本的小节标题，便于核对主题是否重叠。
 *
 * 用法：
 *   node tools/check/audit.mjs            # 打印审计报告
 *   node tools/check/audit.mjs --strict   # 发现跨文件重复断言时以非零码退出（给 CI 用）
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CHECK_DIR = path.join(ROOT, 'tools', 'check');
const TEST_DIR = path.join(ROOT, 'test');
const strict = process.argv.includes('--strict');

/** 归一化：抹掉数字、标点、空白与大小写，只留"这句话在说什么" */
const norm = (s) => s
  .replace(/\$\{[^}]*\}/g, '#')
  .replace(/[0-9]+/g, '#')
  .replace(/[（）()【】[\]，。、：:；;！!？?·\s"'`]/g, '')
  .toLowerCase();

/**
 * 已知且**合理**的跨区域同名断言：每个区域自检"自己的流程跑下来没报 JS 错"，
 * 语义上不是重复覆盖，保留。要往里加先确认它确实属于这一类。
 */
const KNOWN_OK = new Set([
  norm('页面无 JS 报错'),
]);

function collect(dir, filter, re) {
  const out = [];
  for (const f of fs.readdirSync(dir).filter(filter)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(re)) out.push({ file: f, label: m[1], norm: norm(m[1]) });
  }
  return out;
}

const checkFiles = fs.readdirSync(CHECK_DIR)
  .filter((n) => n.endsWith('.mjs') && n !== 'manifest.mjs' && n !== 'run.mjs' && n !== 'audit.mjs');
const testFiles = fs.readdirSync(TEST_DIR).filter((n) => n.endsWith('.test.mjs'));

const uiLabels = [
  ...collect(CHECK_DIR, (n) => checkFiles.includes(n), /ok\(\s*'([^']+)'/g),
  ...collect(CHECK_DIR, (n) => checkFiles.includes(n), /ok\(\s*`([^`]+)`/g),
];
const unitNames = collect(TEST_DIR, (n) => testFiles.includes(n), /test\(\s*'([^']+)'/g);

console.log(`检查脚本：${checkFiles.length} 个 · UI 断言 ${uiLabels.length} 条`);
console.log(`单元测试：${testFiles.length} 个文件 · 用例 ${unitNames.length} 条`);

function group(list) {
  const by = new Map();
  for (const item of list) {
    if (!by.has(item.norm)) by.set(item.norm, []);
    by.get(item.norm).push(item);
  }
  return by;
}

const uiBy = group(uiLabels);
const crossUi = [...uiBy.values()].filter((ls) => new Set(ls.map((x) => x.file)).size > 1);
const sameFileUi = [...uiBy.values()].filter((ls) => new Set(ls.map((x) => x.file)).size === 1 && ls.length > 1);
console.log(`\n=== 跨区域重复的断言：${crossUi.length} 组 ===`);
if (!crossUi.length) console.log('  （无）');
for (const ls of crossUi) console.log(`  · 「${ls[0].label}」 → ${[...new Set(ls.map((x) => x.file))].join(', ')}`);
console.log(`同一脚本内重复：${sameFileUi.length} 组`);
for (const ls of sameFileUi) console.log(`  · 「${ls[0].label}」 ×${ls.length} → ${ls[0].file}`);

const unitBy = group(unitNames);
const crossUnit = [...unitBy.values()].filter((ls) => new Set(ls.map((x) => x.file)).size > 1);
console.log(`\n=== 跨文件同名单元测试：${crossUnit.length} 组 ===`);
if (!crossUnit.length) console.log('  （无）');
for (const ls of crossUnit) console.log(`  · 「${ls[0].name}」 → ${[...new Set(ls.map((x) => x.file))].join(', ')}`);

const themes = {
  '品牌/图标': /Luna|品牌|图标|icon|emoji/i,
  '专辑墙卡片数': /张专辑|卡片|专辑墙/i,
  收藏: /收藏|喜欢|favorite/i,
  '标签三栏': /标签栏|风格栏|三栏|tagbar/i,
  压缩包: /包内|压缩包|archive/i,
  歌词: /歌词|字幕|vtt/i,
};
console.log('\n=== 主题分布（重叠线索，需人工判断是否冗余）===');
for (const [name, re] of Object.entries(themes)) {
  const hits = uiLabels.filter((l) => re.test(l.label));
  console.log(`  ${name}: ${hits.length} 条 → ${[...new Set(hits.map((h) => h.file))].join(', ')}`);
}

console.log('\n=== 各脚本小节（核对主题是否重叠）===');
for (const f of checkFiles) {
  const src = fs.readFileSync(path.join(CHECK_DIR, f), 'utf8');
  const heads = [...src.matchAll(/console\.log\([`'"]\\n— ([^`'"]+)/g)]
    .map((m) => m[1].replace(/—?\s*$/, '').trim());
  console.log(`  ${f}: ${heads.join(' | ') || '（无小节标记）'}`);
}

const dupCount = crossUi.length + sameFileUi.length + crossUnit.length;
console.log(`\n总计可疑重复：${dupCount} 组。`
  + '若某组确属"各区域自检自己的流程"（如"页面无 JS 报错"），保留即可 —— 这里只负责找出来。');
const realCrossUi = crossUi.filter((ls) => !KNOWN_OK.has(ls[0].norm));
if (realCrossUi.length) {
  console.log(`
需要处理（不在已知合理清单里）：${realCrossUi.length} 组`);
  for (const ls of realCrossUi) console.log(`  ⚠ 「${ls[0].label}」 → ${[...new Set(ls.map((x) => x.file))].join(", ")}`);
}
process.exit(strict && realCrossUi.length ? 1 : 0);
