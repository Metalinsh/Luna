/**
 * 把 DSH 会话导出为可读 Markdown。
 *   node export-session.mjs <session.v4.jsonl.zstd> <输出.md>
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const src = process.argv[2];
const out = process.argv[3];
if (!src || !out) {
  console.error('用法：node export-session.mjs <会话文件> <输出.md>');
  process.exit(1);
}

/* ---------------------------------------------------------------- 读取 */

const buf = fs.readFileSync(src);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const offsets = [];
let idx = buf.indexOf(MAGIC, 0);
while (idx !== -1) { offsets.push(idx); idx = buf.indexOf(MAGIC, idx + 4); }

const parts = [];
let badFrames = 0;
for (let i = 0; i < offsets.length; i += 1) {
  const start = offsets[i];
  const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
  try { parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8')); } catch { badFrames += 1; }
}
const records = parts.join('').split('\n').filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

/* ------------------------------------------------------------ 诊断输出 */

const partTypes = new Map();
const userKinds = new Map();
const toolNames = new Map();
for (const r of records) {
  if (r.type === 'assistant/message') {
    for (const c of r.data?.message?.content ?? []) partTypes.set(c.type, (partTypes.get(c.type) ?? 0) + 1);
  }
  if (r.type === 'user/message') {
    const k = r.data?.source?.kind ?? 'unknown';
    userKinds.set(k, (userKinds.get(k) ?? 0) + 1);
  }
  if (r.type === 'tool/call') toolNames.set(r.data?.name, (toolNames.get(r.data?.name) ?? 0) + 1);
}
console.log(`帧 ${offsets.length}（坏帧 ${badFrames}）· 记录 ${records.length}`);
console.log('assistant 内容块类型:', [...partTypes].map(([k, v]) => `${k}:${v}`).join('  '));
console.log('user/message 来源:', [...userKinds].map(([k, v]) => `${k}:${v}`).join('  '));
console.log('工具调用 Top:', [...toolNames].sort((a, b) => b[1] - a[1]).slice(0, 8)
  .map(([k, v]) => `${k}:${v}`).join('  '));

/* ---------------------------------------------------------------- 组装 */

const textOf = (parts2) => (parts2 ?? [])
  .filter((c) => c?.type === 'text' && typeof c.text === 'string')
  .map((c) => c.text).join('\n').trim();

const oneLine = (s, n = 150) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const fmtTime = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '');

const blocks = [];
let compactionAt = null;
const stats = { user: 0, assistant: 0, tools: 0, skipped: 0 };

for (let i = 0; i < records.length; i += 1) {
  const r = records[i];

  if (String(r.type).startsWith('compaction/') && r.type === 'compaction/start' && compactionAt === null) {
    compactionAt = blocks.length;
    blocks.push({ kind: 'note', text: '> ⚠️ **此处发生了一次「上下文压缩」**（桌宠插件的自动优化触发）：'
      + '更早的对话被折叠成摘要以腾出上下文窗口。压缩前的原始记录仍完整保存在会话文件里。' });
    continue;
  }

  if (r.type === 'user/message') {
    const kind = r.data?.source?.kind;
    const body = textOf(r.data?.content);
    if (!body) { stats.skipped += 1; continue; }

    // 只把「你真正说的话」当作对话内容；其余是系统注入，一律不当作你的发言
    if (kind === 'compact-checkpoint') {
      blocks.push({ kind: 'note', text: '> 📦 **上下文压缩摘要**（系统注入）：此处之前的对话被折叠成摘要交付给我，'
        + '目的是腾出上下文窗口。原始记录仍完整保存在会话文件里。以下为摘要原文：\n>\n'
        + body.split('\n').map((l) => `> ${l}`).join('\n') });
      continue;
    }
    if (kind !== 'user') { stats.skipped += 1; continue; }

    stats.user += 1;
    blocks.push({ kind: 'user', time: r.time, text: body });
    continue;
  }

  if (r.type === 'assistant/message') {
    const body = textOf(r.data?.message?.content);
    if (!body) continue;
    const last = blocks[blocks.length - 1];
    if (last?.kind === 'assistant') last.text += `\n\n${body}`;
    else { stats.assistant += 1; blocks.push({ kind: 'assistant', time: r.time, text: body }); }
    continue;
  }

  if (r.type === 'tool/call') {
    stats.tools += 1;
    const name = r.data?.name ?? '?';
    let hint = '';
    try {
      const a = JSON.parse(r.data?.arguments ?? '{}');
      hint = oneLine(a.description || a.command || a.pattern || a.file_path || a.path || '', 130);
    } catch { /* 忽略 */ }
    blocks.push({ kind: 'tool', text: `\`${name}\`${hint ? ` — ${hint}` : ''}` });
    continue;
  }
}

/* ---------------------------------------------------------------- 写出 */

const lines = [];
lines.push('# 本地专辑管理软件 · 对话记录');
lines.push('');
lines.push(`- **来源会话**：\`${path.basename(path.dirname(src))}\``);
lines.push(`- **导出时间**：${new Date().toLocaleString('zh-CN', { hour12: false })}`);
const firstTime = records.find((r) => r.time)?.time;
const lastTime = [...records].reverse().find((r) => r.time)?.time;
lines.push(`- **时间跨度**：${fmtTime(firstTime)} ~ ${fmtTime(lastTime)}`);
lines.push(`- **规模**：你的消息 ${stats.user} 条 · 我的回复 ${stats.assistant} 段 · 工具调用 ${stats.tools} 次 · 原始记录 ${records.length} 条`);
lines.push('');
lines.push('> 本文由会话文件直接导出（`session.v4.jsonl.zstd` 逐帧 zstd 解压），不含我的内部推理过程，工具调用只保留摘要。');
lines.push('');
lines.push('---');
lines.push('');

let n = 0;
for (const b of blocks) {
  if (b.kind === 'user') {
    n += 1;
    lines.push(`## ${n}. 👤 你`);
    if (b.time) lines.push(`<sub>${fmtTime(b.time)}</sub>`);
    lines.push('');
    lines.push(b.text);
    lines.push('');
  } else if (b.kind === 'assistant') {
    lines.push('### 🤖 我');
    if (b.time) lines.push(`<sub>${fmtTime(b.time)}</sub>`);
    lines.push('');
    lines.push(b.text);
    lines.push('');
  } else if (b.kind === 'tool') {
    lines.push(`- 🔧 ${b.text}`);
  } else if (b.kind === 'note') {
    lines.push('');
    lines.push(b.text);
    lines.push('');
  }
}

// 把工具行收进可折叠块，保持正文清爽
let md = lines.join('\n');
md = md.replace(/(?:^- 🔧 .*\n?)+/gm, (m) => {
  const items = m.trim().split('\n').map((s) => `  ${s}`);
  return `<details><summary>🔧 工具调用（${items.length} 次）</summary>\n\n${items.join('\n')}\n\n</details>\n`;
});

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, md, 'utf8');

console.log(`\n已写出：${out}`);
console.log(`文件大小：${(fs.statSync(out).size / 1048576).toFixed(2)} MB`);
console.log(`对话轮次：${n} 轮（你发起的）`);
if (compactionAt !== null) console.log('已标注上下文压缩位置');
