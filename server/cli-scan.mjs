/**
 * 命令行扫描工具：
 *   node server/cli-scan.mjs "E:\Music"          先加入音乐库，再全量扫描
 *   node server/cli-scan.mjs --all               只扫描已登记的音乐库
 */
import path from 'node:path';
import fsp from 'node:fs/promises';

import * as store from './db.mjs';
import { scanState, startScan, waitForScan } from './scanner.mjs';

const args = process.argv.slice(2);
const targets = args.filter((a) => !a.startsWith('--'));

if (!args.includes('--all') && targets.length === 0) {
  console.log('用法：node server/cli-scan.mjs <音乐目录> [更多目录…]  |  --all');
  process.exit(1);
}

for (const target of targets) {
  const resolved = path.resolve(target);
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) {
    console.error(`跳过（不是目录）：${resolved}`);
    continue;
  }
  const lib = store.addLibrary(resolved);
  console.log(`音乐库已登记：#${lib.id} ${lib.path}`);
}

const timer = setInterval(() => {
  const { phase, processed, filesFound, added, updated, skipped, removed, coverExtracted } = scanState;
  process.stdout.write(
    `\r${phase}  ${processed}/${filesFound}  新增 ${added}  更新 ${updated}  跳过 ${skipped}  清理 ${removed}  封面 ${coverExtracted}   `,
  );
}, 250);

startScan({});
await waitForScan();
clearInterval(timer);

process.stdout.write('\n');
const s = scanState;
console.log(`扫描${s.cancelRequested ? '被取消' : '完成'}：新增 ${s.added}，更新 ${s.updated}，未变化 ${s.skipped}，清理 ${s.removed}，提取封面 ${s.coverExtracted}，失败 ${s.failed}`);
for (const err of s.errors) console.log(`  ! ${err}`);

const stats = store.getStats();
console.log(`索引现状：${stats.albums} 张专辑 / ${stats.tracks} 首曲目 / ${stats.artists} 位艺术家`);
store.closeDb();
process.exit(0);
