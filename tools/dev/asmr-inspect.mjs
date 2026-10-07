/**
 * 音声（ASMR）专辑结构分析工具。
 *
 *   node tools/asmr-inspect.mjs "<专辑根目录>"
 *
 * 输出：目录→版本分组、每组的音频数量与体积、抽样标签、字幕/台本等附属文件，
 * 以及当前索引里是否已收录。用于确认「同一专辑多版本」的实际组织方式。
 */
import fs from 'node:fs';
import path from 'node:path';

import { parseFile } from 'music-metadata';

const AUDIO = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.aiff']);
const SUBTITLE = new Set(['.vtt', '.lrc', '.srt', '.ass']);
const IMAGE = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

const ROOT = process.argv[2];
if (!ROOT || !fs.existsSync(ROOT)) {
  console.error('用法：node tools/asmr-inspect.mjs "<专辑根目录>"');
  process.exit(1);
}

const fmtSize = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB`
  : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);

const groups = new Map();
let totalFiles = 0;

(function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    totalFiles += 1;
    let size = 0;
    try { size = fs.statSync(full).size; } catch { /* 忽略 */ }
    const ext = path.extname(e.name).toLowerCase();
    const kind = AUDIO.has(ext) ? 'audio' : SUBTITLE.has(ext) ? 'subtitle'
      : IMAGE.has(ext) ? 'image' : 'text';
    const rel = path.relative(ROOT, dir);
    if (!groups.has(rel)) groups.set(rel, { audio: [], subtitle: [], image: [], text: [] });
    groups.get(rel)[kind].push({ name: e.name, size, ext, full });
  }
}(ROOT));

console.log('='.repeat(88));
console.log(`专辑根目录：${path.basename(ROOT)}`);
console.log(`共 ${totalFiles} 个文件；含音频的目录 ${[...groups.values()].filter((g) => g.audio.length).length} 个`);
console.log('='.repeat(88));

const audioGroups = [...groups.entries()].filter(([, g]) => g.audio.length)
  .sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'));

let grandTotal = 0;
let grandCount = 0;
for (const [rel, g] of audioGroups) {
  const bytes = g.audio.reduce((s, f) => s + f.size, 0);
  grandTotal += bytes;
  grandCount += g.audio.length;
  const exts = {};
  for (const f of g.audio) exts[f.ext] = (exts[f.ext] ?? 0) + 1;
  console.log(`\n【${rel || '(根目录)'}】`);
  console.log(`  ${g.audio.length} 个音频 / ${fmtSize(bytes)}　`
    + Object.entries(exts).map(([k, v]) => `${k}×${v}`).join(' ')
    + `${g.subtitle.length ? `　字幕 ${g.subtitle.length}` : ''}`
    + `${g.text.length ? `　文本 ${g.text.length}` : ''}`);
}

console.log(`\n合计：${grandCount} 个音频 / ${fmtSize(grandTotal)}`);

/* ------------------------------------------------------------ 抽样标签 */

console.log(`\n${'='.repeat(88)}\n抽样标签（判断能否用标签区分版本）\n${'='.repeat(88)}`);
const picks = [];
for (const [rel, g] of audioGroups) {
  const first = g.audio[0];
  if (first) picks.push([rel || '(根目录)', first.full]);
}

for (const [label, file] of picks) {
  try {
    const m = await parseFile(file, { duration: true, skipCovers: true });
    const c = m.common;
    console.log(`\n【${label}】${path.basename(file)}`);
    console.log(`  ${m.format.container ?? '?'} / ${m.format.codec ?? '?'} · `
      + `${m.format.bitrate ? `${Math.round(m.format.bitrate / 1000)} kbps` : '—'} · `
      + `${m.format.sampleRate ?? '?'} Hz · ${m.format.bitsPerSample ?? '?'} bit · `
      + `${m.format.duration ? `${Math.round(m.format.duration)}s` : '—'}`);
    console.log(`  album=${JSON.stringify(c.album)} artist=${JSON.stringify(c.artist)} `
      + `albumartist=${JSON.stringify(c.albumartist)} title=${JSON.stringify(c.title)} `
      + `track=${JSON.stringify(c.track?.no)} year=${JSON.stringify(c.year)}`);
    console.log(`  内嵌封面：${c.picture?.length ? `${c.picture.length} 张` : '无'}`);
  } catch (err) {
    console.log(`\n【${label}】读取失败：${err.message}`);
  }
}
