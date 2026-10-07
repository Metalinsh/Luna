/**
 * 音声发行解析结果查看器（验证《音声专辑设计》R1–R15 用）。
 *
 *   node tools/asmr-parse.mjs "<发行根目录>" [--no-tags]
 */
import path from 'node:path';

import { analyzeRelease, locateRelease } from '../server/asmr.mjs';

const target = process.argv[2];
const readTags = !process.argv.includes('--no-tags');
if (!target) {
  console.error('用法：node tools/asmr-parse.mjs "<发行根目录>" [--no-tags]');
  process.exit(1);
}

const fmt = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB`
  : n >= 1048576 ? `${(n / 1048576).toFixed(0)} MB` : `${(n / 1024).toFixed(0)} KB`);

const located = locateRelease(target);
const result = await analyzeRelease(target, { readTags });

console.log('='.repeat(88));
console.log(`发行根：${result.folderName}`);
console.log(`RJ 号：${result.rjCode ?? '(未识别)'}`
  + `　特典 RJ：${result.nestedRjCodes.length ? result.nestedRjCodes.join(', ') : '无'}`
  + `　含特典：${result.hasBonus ? '是' : '否'}`);
console.log(`标题（文件夹名）：${result.titleFromFolder}`);
console.log(`标题（内嵌标签）：${result.titleFromTag ?? '—'}`);
console.log(`艺术家（内嵌标签）：${result.artistFromTag ?? '—'}`);
console.log(`封面：${result.cover ? path.relative(target, result.cover.path) + ` (${fmt(result.cover.size)})` : '未找到'}`);
console.log(`文件：${result.stats.files} 个（音频 ${result.stats.audio} / 视频 ${result.stats.video} / 其他 ${result.stats.other}）`);
console.log('='.repeat(88));

console.log(`\n【版本】共 ${result.stats.versionCount} 个主版本`
  + `${result.stats.bonusVersionCount ? ` + ${result.stats.bonusVersionCount} 个特典版本` : ''}`);
for (const v of result.versions) {
  const group = v.group === 'bonus' ? '[特典]' : '      ';
  console.log(`  播放用 ${v.preferredFormat.padEnd(5)} ${group} ${v.name.padEnd(26)} `
    + `含格式 ${v.formats.join('/').padEnd(8)} ${String(v.fileCount).padStart(3)} 个 ${fmt(v.bytes).padStart(8)}`);
}

console.log(`\n【主轨道】合并后 ${result.tracks.length} 行`
  + `（其中 ${result.tracks.filter((t) => t.conflict).length} 行存在待确认冲突）`);
for (const t of result.tracks.slice(0, 24)) {
  const versions = [...new Set(t.versions.map((v) => v.versionName))];
  console.log(`  ${String(t.trackNo ?? '—').padStart(3)} ${t.conflict ? '⚠' : ' '} `
    + `${t.title.slice(0, 32).padEnd(34)} 版本 ${versions.length} 个${t.hasVideo ? ' + 视频版' : ''}`);
  if (versions.length > 1) console.log(`        ${versions.join(' │ ').slice(0, 108)}`);
}
if (result.tracks.length > 24) console.log(`  …还有 ${result.tracks.length - 24} 行`);

if (result.bonusTracks.length) {
  console.log(`\n【特典】${result.bonusTracks.length} 条`);
  for (const t of result.bonusTracks.slice(0, 10)) {
    const versions = [...new Set(t.versions.map((v) => v.versionName))];
    console.log(`  ${t.title.slice(0, 40).padEnd(42)} 版本 ${versions.length} 个`
      + `${t.hasVideo ? ' + 视频版' : ''}`);
  }
}

if (result.ignored.length) {
  console.log(`\n【已忽略】${result.ignored.length} 个文件`);
  const byReason = new Map();
  for (const i of result.ignored) byReason.set(i.reason, (byReason.get(i.reason) ?? 0) + 1);
  for (const [reason, n] of byReason) console.log(`  ${String(n).padStart(3)} 个：${reason}`);
}

if (result.mergeCandidates?.length) {
  console.log(`\n【合并待确认】${result.mergeCandidates.length} 组（把握不足，需人工判断是否同一轨道）`);
  for (const c of result.mergeCandidates) {
    console.log(`  「${c.a.title}」  版本[${[...new Set(c.a.versions)].join(', ')}]`);
    console.log(`  「${c.b.title}」  版本[${[...new Set(c.b.versions)].join(', ')}]`);
    console.log(`        依据：${c.reason} · 占比 ${c.ratio} · 相似度 ${c.similarity}`);
    console.log('');
  }
} else {
  console.log('\n【合并待确认】无');
}

if (result.conflicts.length) {
  console.log(`\n【冲突待确认】${result.conflicts.length} 项`);
  for (const c of result.conflicts) {
    if (c.type === 'filename-variant') {
      console.log(`  文件名与版本标识不一致：${c.file}`);
      console.log(`        文件夹版本「${c.versionFromFolder}」· 残留「${c.leftover}」· 相关标记「${c.relatedToken}」`);
    } else {
      console.log(`  标题不一致：文件夹「${c.folderName}」 vs 标签「${c.tagValue}」`);
    }
    console.log(`        → ${c.note}`);
  }
} else {
  console.log('\n【冲突待确认】无');
}
