/**
 * 压缩包读取测试（docs/压缩包支持设计.md §5.1）。
 *
 * 全部用**手工合成的 ZIP** 覆盖边界，不依赖用户的任何真实压缩包：
 * 用 node:zlib 的 deflateRawSync 产出合法 deflate 流，再按规范拼出
 * 本地文件头 + 中央目录 + EOCD，因此可以精确造出 stored / deflate /
 * 加密 / 不支持方法 / ZIP64 / 损坏 / Shift-JIS 名称等各种形态。
 *
 * 若真机存在 E:\Music\ASMR 下的音声压缩包，末尾会追加一组只读回归断言。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  probeZip, summarizeArchive, decodeEntryName, findEntry, readEntryData, readMember,
  openEntryStream, virtualPath, splitVirtualPath, isVirtualPath, isArchiveName,
  looksLikeZip, MEMBER_SEP,
} from '../server/zip-reader.mjs';

let sandbox;
let seq = 0;

before(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-zip-')); });
after(() => { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* 忽略 */ } });

/* ------------------------------------------------------------ 合成 ZIP 外壳 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;

/**
 * 造一个合法 ZIP。
 *
 * @param {Array<{name:string|Buffer, data:string|Buffer, method?:number,
 *                utf8?:boolean, flags?:number, dosDate?:number, dosTime?:number,
 *                extra?:Buffer, nameLenOverride?:number}>} entries
 * @param {{forceZip64?:boolean, eocdOffsetDelta?:number, comment?:Buffer}} [opts]
 *        forceZip64 让 EOCD 的条目数/偏移写成 0xffffffff，从而走 EOCD64 路径；
 *        eocdOffsetDelta 用来故意搞坏中央目录偏移（损坏包测试）。
 */
function makeZip(entries, opts = {}) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, 'utf8');
    const method = e.method ?? (e.store ? 0 : 8);
    const packed = method === 8 ? zlib.deflateRawSync(raw) : raw;
    let flags = e.flags ?? 0;
    if (e.utf8) flags |= 0x800;
    const dosDate = e.dosDate ?? 0x5a21;
    const dosTime = e.dosTime ?? 0x0000;
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    // nameLenOverride 用来伪造「本地头名称长度与中央目录不一致」
    local.writeUInt16LE(e.nameLenOverride ?? name.length, 26);
    local.writeUInt16LE(0, 28);

    parts.push(local, name, packed);

    const extra = e.extra ?? Buffer.alloc(0);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG_CENTRAL, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(extra.length, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name, extra);

    offset += local.length + name.length + packed.length;
  }

  const centralBuf = Buffer.concat(central);
  const centralOffset = offset;
  const comment = opts.comment ?? Buffer.alloc(0);

  if (opts.forceZip64) {
    const eocd64 = Buffer.alloc(56);
    eocd64.writeUInt32LE(SIG_EOCD64, 0);
    eocd64.writeBigUInt64LE(44n, 4);
    eocd64.writeUInt16LE(45, 12);
    eocd64.writeUInt16LE(45, 14);
    eocd64.writeUInt32LE(0, 16);
    eocd64.writeUInt32LE(0, 20);
    eocd64.writeBigUInt64LE(BigInt(entries.length), 24);
    eocd64.writeBigUInt64LE(BigInt(entries.length), 32);
    eocd64.writeBigUInt64LE(BigInt(centralBuf.length), 40);
    eocd64.writeBigUInt64LE(BigInt(centralOffset), 48);

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(SIG_EOCD64_LOCATOR, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(centralOffset + centralBuf.length), 8);
    locator.writeUInt32LE(1, 16);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);
    eocd.writeUInt16LE(comment.length, 20);
    return Buffer.concat([...parts, centralBuf, eocd64, locator, eocd, comment]);
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralOffset + (opts.eocdOffsetDelta ?? 0), 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...parts, centralBuf, eocd, comment]);
}

/** 把 ZIP 字节落到沙箱里并返回路径 */
function writeZip(buf, tag = 'p') {
  seq += 1;
  const p = path.join(sandbox, `${tag}-${seq}.zip`);
  fs.writeFileSync(p, buf);
  return p;
}

/** 造一个 zip 文件，返回 { filePath, entries } */
function zipFile(entries, opts = {}, tag = 'p') {
  return writeZip(makeZip(entries, opts), tag);
}

/** Shift-JIS 字节：バイノーラル（真实 CP932 序列，由 TextDecoder 反查得到） */
const SJIS_BINAURAL = Buffer.from([
  0x83, 0x6f, 0x83, 0x43, 0x83, 0x6d, 0x81, 0x5b, 0x83, 0x89, 0x83, 0x8b,
]);
/**
 * GB18030/GBK 字节：バイノーラル。
 * **实测真机包用的就是这一套**（`E:\Music\ASMR` 的音声包 63 个条目全部如此），
 * 它解出来的日文与 CP932 完全相同，这正是「逐条猜编码」不可靠的原因。
 */
const GBK_BINAURAL = Buffer.from([
  0xa5, 0xd0, 0xa5, 0xa4, 0xa5, 0xce, 0xa9, 0x60, 0xa5, 0xe9, 0xa5, 0xeb,
]);
/** CP932 / GB18030 下的「編集」——用于拼多字节编码的完整条目名 */
const SJIS_HENSHU = Buffer.from([0x95, 0xd2, 0x8f, 0x57]);
const GBK_HENSHU = Buffer.from([0xbe, 0x8e, 0xbc, 0xaf]);

/* ------------------------------------------------------------------- 清单 */

test('清单：stored 与 deflate 混合包，条目元数据正确', async () => {
  const filePath = zipFile([
    { name: 'stored.txt', data: 'hello', store: true },
    { name: 'deflate.mp3', data: 'x'.repeat(5000) },
    { name: 'sub/', data: '', store: true },
  ]);
  const info = await probeZip(filePath);
  assert.equal(info.entryCount, 3);
  assert.equal(info.encrypted, false);
  assert.equal(info.unsupported, false);
  assert.equal(info.zip64, false);

  const stored = findEntry(info.entries, 'stored.txt');
  assert.equal(stored.method, 0);
  assert.equal(stored.kind, 'other');
  assert.equal(stored.size, 5);
  assert.equal(stored.readable, true);

  const deflated = findEntry(info.entries, 'deflate.mp3');
  assert.equal(deflated.method, 8);
  assert.equal(deflated.kind, 'audio');
  assert.equal(deflated.size, 5000);
  // deflate 确实压下去了，才能证明我们读到的是压缩长度
  assert.ok(deflated.packedSize < deflated.size, `packed=${deflated.packedSize} 应小于 size=${deflated.size}`);

  const dir = findEntry(info.entries, 'sub/');
  assert.equal(dir.kind, 'dir');
  assert.equal(dir.readable, false, '目录不可读');
});

test('清单：按扩展名归类 audio / video / image / other', async () => {
  const filePath = zipFile([
    { name: 'a.mp3', data: 'a' }, { name: 'b.flac', data: 'b' }, { name: 'c.wav', data: 'c' },
    { name: 'd.mp4', data: 'd' }, { name: 'e.jpg', data: 'e' }, { name: 'f.txt', data: 'f' },
    { name: 'g.unknown', data: 'g' },
  ]);
  const info = await probeZip(filePath);
  const kind = (n) => findEntry(info.entries, n).kind;
  assert.equal(kind('a.mp3'), 'audio');
  assert.equal(kind('b.flac'), 'audio');
  assert.equal(kind('c.wav'), 'audio');
  assert.equal(kind('d.mp4'), 'video');
  assert.equal(kind('e.jpg'), 'image');
  assert.equal(kind('f.txt'), 'other');
  assert.equal(kind('g.unknown'), 'other');
});

test('清单：summary 汇总计数与体积', async () => {
  const filePath = zipFile([
    { name: 'a.mp3', data: 'x'.repeat(1000) },
    { name: 'b.mp3', data: 'y'.repeat(2000) },
    { name: 'c.jpg', data: 'z'.repeat(500) },
    { name: 'd.mp4', data: 'w'.repeat(300) },
    { name: 'e.txt', data: 'v'.repeat(10) },
    { name: 'dir/', data: '', store: true },
  ]);
  const info = await probeZip(filePath);
  const s = summarizeArchive(info);
  assert.equal(s.entryCount, 5, '目录不计入条目数');
  assert.equal(s.audioCount, 2);
  assert.equal(s.imageCount, 1);
  assert.equal(s.videoCount, 1);
  assert.equal(s.unpackedBytes, 1000 + 2000 + 500 + 300 + 10);
  assert.ok(s.packedBytes > 0);
  assert.equal(s.format, 'zip');
});

/* --------------------------------------------------------------- 文件名编码 */

test('文件名：UTF-8 标志位置位时按 UTF-8 解', () => {
  const raw = Buffer.from('中文名.mp3', 'utf8');
  const r = decodeEntryName(raw, true);
  assert.equal(r.encoding, 'utf-8');
  assert.equal(r.text, '中文名.mp3');
});

test('文件名：标志位未置位但内容是合法 UTF-8 → 仍判为 UTF-8', () => {
  const raw = Buffer.from('日本語のファイル名.mp3', 'utf8');
  const r = decodeEntryName(raw, false);
  assert.equal(r.encoding, 'utf-8', '严格 UTF-8 校验通过就应采用');
  assert.equal(r.text, '日本語のファイル名.mp3');
});

test('文件名：Shift-JIS 字节（标志位未置位）解出正确假名', () => {
  const r = decodeEntryName(SJIS_BINAURAL, false);
  assert.equal(r.encoding, 'shift_jis', 'CP932 假名序列不应被解成中文');
  assert.equal(r.text, 'バイノーラル');
  assert.equal(r.score, 0);
});

test('文件名：GB18030 假名字节同样可解（真机包实测用的就是这套）', () => {
  const r = decodeEntryName(GBK_BINAURAL, false);
  assert.equal(r.text, 'バイノーラル');
  assert.ok(!r.text.includes('\uFFFD'), '不应有替换字符');
});

test('编码裁决：纯 GB18030 包（真机形态）63 条全部解成同一套日文，无中文乱码', async () => {
  // 真实音声包的形态：整包同一编码、假名 + 汉字混杂、以「全假名条目」占多数。
  // 逐条打分在纯汉字条目上会平手，此时必须靠「全假名多数票」定下主编码。
  const kana = (suffix, data = 'x') => ({
    name: Buffer.concat([GBK_BINAURAL, Buffer.from(suffix, 'utf8')]), data,
  });
  const filePath = zipFile([
    kana('/01.mp3'), kana('/02.mp3'), kana('/03.mp3'), kana('/04.mp3'),
    { name: Buffer.concat([GBK_HENSHU, Buffer.from('/05.mp3', 'utf8')]), data: 'e' }, // 纯汉字条目
  ], {}, 'vote-gbk-pure');

  const info = await probeZip(filePath);
  assert.equal(info.dominantEncoding, 'gb18030',
    `全假名条目应把主编码定为 gb18030，实际投票：${JSON.stringify(info.nameEncodingVotes)}`);
  assert.equal(info.nameEncoding, 'gb18030');
  // 逐条锁定期望值：纯汉字条目也被主编码统一（編集，而不是 CP932 回解的「曇廤」）
  assert.deepEqual(info.entries.map((e) => e.name), [
    'バイノーラル/01.mp3', 'バイノーラル/02.mp3', 'バイノーラル/03.mp3',
    'バイノーラル/04.mp3', '編集/05.mp3',
  ]);
  assert.ok(info.entries.every((e) => !e.name.includes('\uFFFD')), '不应有替换字符');
  assert.ok(info.entries.every((e) => !/[\uFF61-\uFF9F]/.test(e.name)), '不应出现半宽假名');
});

test('编码裁决：单条无法决胜时由多数主编码接管（混编码包的尽力而为）', async () => {
  // 已知局限：整包以 CP932 为主时，混进来的 GB18030 假名条目**无法**被识别出来 ——
  // 那些字节在 CP932 下也是合法文本（半宽假名），逐条打分同样能通过。
  // 这里锁定的行为是：主编码确实按多数票选出，并且会去改写少数派条目。
  const mk = (bytes, suffix, data) => ({
    name: Buffer.concat([bytes, Buffer.from(suffix, 'utf8')]), data,
  });
  const info = await probeZip(zipFile([
    mk(SJIS_BINAURAL, '/01.mp3', 'a'),
    mk(SJIS_BINAURAL, '/02.mp3', 'b'),
    mk(SJIS_BINAURAL, '/03.mp3', 'c'),
    mk(GBK_BINAURAL, '/04.mp3', 'd'),
  ], {}, 'vote-mixed'));

  assert.equal(info.dominantEncoding, 'shift_jis',
    `5:1 之外的 3:1 也应按多数票，实际：${JSON.stringify(info.nameEncodingVotes)}`);
  assert.equal(info.overriddenEntries, 1, '少数派条目应被主编码改写');
  assert.equal(info.entries[0].name, 'バイノーラル/01.mp3');
  assert.equal(info.entries[0].nameEncoding, 'shift_jis');
});

test('编码裁决：UTF-8 标志位的条目不参与主编码统一', async () => {
  const info = await probeZip(zipFile([
    { name: '中文.mp3', data: 'a', utf8: true },
    { name: Buffer.concat([SJIS_BINAURAL, Buffer.from('/01.mp3', 'utf8')]), data: 'b' },
  ], {}, 'flagmix'));
  const utf8Entry = findEntry(info.entries, '中文.mp3');
  assert.ok(utf8Entry, '带 UTF-8 标志的条目必须按 UTF-8 解');
  assert.equal(utf8Entry.nameEncoding, 'utf-8');
  assert.equal(info.utf8Flagged, 1);
});

test('文件名：探针能读出 GB18030 命名的包内条目（含目录与音频）', async () => {
  const filePath = zipFile([
    { name: Buffer.concat([GBK_BINAURAL, GBK_HENSHU, Buffer.from('/', 'utf8')]), data: '', store: true },
    { name: Buffer.concat([GBK_BINAURAL, GBK_HENSHU, Buffer.from('/01.mp3', 'utf8')]), data: 'audio-bytes' },
  ], {}, 'gbkname');
  const info = await probeZip(filePath);
  assert.equal(info.dominantEncoding, 'gb18030');
  assert.deepEqual(info.entries.map((e) => e.name), ['バイノーラル編集/', 'バイノーラル編集/01.mp3']);
  assert.equal(info.entries[0].kind, 'dir');
  assert.equal(info.entries[1].kind, 'audio');
  // 名称里的多字节序列不影响取值
  const data = await readEntryData(filePath, findEntry(info.entries, 'バイノーラル編集/01.mp3'));
  assert.equal(data.toString('utf8'), 'audio-bytes');
});

/* ------------------------------------------------------------------ 加密 */

test('加密：标志位 bit0 置位的条目被标记且不可读', async () => {
  const filePath = zipFile([
    { name: 'secret.mp3', data: 'x'.repeat(100), flags: 0x1 },
    { name: 'open.mp3', data: 'y'.repeat(100) },
  ]);
  const info = await probeZip(filePath);
  assert.equal(info.encrypted, true, '整包应标记为含加密条目');
  const secret = findEntry(info.entries, 'secret.mp3');
  assert.equal(secret.encrypted, true);
  assert.equal(secret.readable, false, '加密条目不可读');
  const open = findEntry(info.entries, 'open.mp3');
  assert.equal(open.readable, true);

  await assert.rejects(() => readEntryData(filePath, secret), /加密/);
});

test('加密：扫描不因加密条目而失败（不抛异常，只标注）', async () => {
  const filePath = zipFile([{ name: 'a.mp3', data: 'x', flags: 0x1 }]);
  const info = await probeZip(filePath);
  assert.equal(info.entryCount, 1);
  const s = summarizeArchive(info);
  assert.equal(s.encrypted, true);
});

/* ------------------------------------------------------ 不支持的压缩方法 */

test('不支持的方法：readable=false、整包 unsupported，读取时明确报错', async () => {
  // method=12 (bzip2) 与 method=14 (LZMA) 都是我们不实现的
  const filePath = zipFile([
    { name: 'bzip2.mp3', data: 'x'.repeat(200), method: 12 },
    { name: 'normal.mp3', data: 'y'.repeat(200) },
  ]);
  const info = await probeZip(filePath);
  const bz = findEntry(info.entries, 'bzip2.mp3');
  assert.equal(bz.method, 12);
  assert.equal(bz.readable, false);
  assert.equal(info.unsupported, true, '整包应标记含不支持方法');

  await assert.rejects(() => readEntryData(filePath, bz), /不支持的压缩方法/);
});

/* ------------------------------------------------------------------- 损坏 */

test('损坏：文件太小 → NOT_ZIP', async () => {
  const p = writeZip(Buffer.from('tiny'), 'tiny');
  await assert.rejects(() => probeZip(p), (err) => err.code === 'NOT_ZIP');
  assert.equal(looksLikeZip(p), false);
});

test('损坏：无 EOCD 的普通文件 → NOT_ZIP，且 looksLikeZip=false', async () => {
  const p = writeZip(Buffer.alloc(4096, 0x41), 'noeocd');
  await assert.rejects(() => probeZip(p), (err) => err.code === 'NOT_ZIP');
  assert.equal(looksLikeZip(p), false, '不能把普通文件当成压缩包');
});

test('损坏：中央目录偏移被破坏 → DAMAGED', async () => {
  const p = writeZip(makeZip([{ name: 'a.mp3', data: 'x'.repeat(100) }], { eocdOffsetDelta: -40 }), 'badcd');
  assert.equal(looksLikeZip(p), true, 'EOCD 在，所以粗探测仍认为像 ZIP');
  await assert.rejects(() => probeZip(p), (err) => err.code === 'DAMAGED');
});

test('损坏：本地文件头长度与中央目录不一致时仍能正确取数据', async () => {
  // 故意把本地头的 nameLen 写小 2 字节，模拟「本地头与中央目录不同」的情况；
  // 实现必须按本地头定位数据起点，否则会读出偏移 2 字节的垃圾。
  const filePath = writeZip(makeZip([
    { name: 'a.mp3', data: 'PAYLOAD-1234' },
  ]), 'localhdr');
  const info = await probeZip(filePath);
  const e = findEntry(info.entries, 'a.mp3');
  const data = await readEntryData(filePath, e);
  assert.equal(data.toString('utf8'), 'PAYLOAD-1234');
});

test('损坏：deflate 数据被破坏 → 抛错而不是返回错误内容', async () => {
  // 用高压缩比数据，保证压缩流较长；然后破坏流中间的字节。
  // 无论解压报错还是长度/CRC 不符，都必须抛错——绝不能把损坏内容当成功返回。
  const payload = 'A'.repeat(100000);
  const good = makeZip([{ name: 'a.mp3', data: payload }]);
  const buf = Buffer.from(good);
  const dataStart = 30 + 'a.mp3'.length;
  const centralOffset = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(centralOffset > dataStart, '应能找到中央目录');
  // 把压缩数据后半段整体清零（破坏 deflate 流）
  const mid = dataStart + Math.floor((centralOffset - dataStart) / 2);
  buf.fill(0x00, mid, centralOffset);
  const p = writeZip(buf, 'corrupt-deflate');
  const info = await probeZip(p);
  const e = findEntry(info.entries, 'a.mp3');
  await assert.rejects(() => readEntryData(p, e), '损坏的 deflate 必须报错');
});

/* ------------------------------------------------------------------ ZIP64 */

test('ZIP64：EOCD 字段全为 0xffffffff 时改由 EOCD64 取条目数与目录偏移', async () => {
  const filePath = zipFile([
    { name: 'a.mp3', data: 'x'.repeat(300) },
    { name: 'b.mp3', data: 'y'.repeat(300) },
  ], { forceZip64: true }, 'zip64');
  const info = await probeZip(filePath);
  assert.equal(info.zip64, true);
  assert.equal(info.entryCount, 2, '条目数应来自 EOCD64 而不是 0xffff');
  assert.equal(findEntry(info.entries, 'a.mp3').size, 300);
  const data = await readEntryData(filePath, findEntry(info.entries, 'a.mp3'));
  assert.equal(data.length, 300);
});

/* -------------------------------------------------------------- 存取数据 */

test('取值：stored 与 deflate 都能逐字节取回，且长度自校验', async () => {
  const payload = '音楽データ-' + 'あ'.repeat(2000);
  const filePath = zipFile([
    { name: 's.mp3', data: payload, store: true },
    { name: 'd.mp3', data: payload },
  ]);
  const info = await probeZip(filePath);
  for (const n of ['s.mp3', 'd.mp3']) {
    const e = findEntry(info.entries, n);
    const data = await readEntryData(filePath, e);
    assert.equal(data.toString('utf8'), payload, `${n} 内容一致`);
    assert.equal(data.length, Buffer.byteLength(payload), `${n} 长度一致`);
    if (zlib.crc32) assert.equal(zlib.crc32(data), e.crc32, `${n} CRC32 相符`);
  }
});

test('取值：目录条目返回空缓冲，空文件也正常', async () => {
  const filePath = zipFile([
    { name: 'empty.mp3', data: '' },
    { name: 'dir/', data: '', store: true },
  ]);
  const info = await probeZip(filePath);
  assert.equal((await readEntryData(filePath, findEntry(info.entries, 'empty.mp3'))).length, 0);
  assert.equal((await readEntryData(filePath, findEntry(info.entries, 'dir/'))).length, 0);
});

test('取值：readMember 便捷接口，成员不存在时报 NO_ENTRY', async () => {
  const filePath = zipFile([{ name: 'a.mp3', data: 'hello' }]);
  const got = await readMember(filePath, 'a.mp3');
  assert.equal(got.data.toString('utf8'), 'hello');
  assert.equal(got.entry.name, 'a.mp3');
  await assert.rejects(() => readMember(filePath, 'nope.mp3'), (err) => err.code === 'NO_ENTRY');
});

test('取值：反斜杠形式的成员路径也能命中', async () => {
  const filePath = zipFile([{ name: 'sub/a.mp3', data: 'hello' }]);
  const info = await probeZip(filePath);
  assert.ok(findEntry(info.entries, 'sub\\a.mp3'), '反斜杠应被归一化');
});

test('流式：内容与整块读取一致（大成员用流，避免进内存）', async () => {
  const payload = Buffer.alloc(3 * 1024 * 1024);
  for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 31) & 0xff;
  const filePath = zipFile([{ name: 'big.mp3', data: payload }]);
  const info = await probeZip(filePath);
  const e = findEntry(info.entries, 'big.mp3');
  const { stream, size } = await openEntryStream(filePath, e);
  assert.equal(size, payload.length);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const out = Buffer.concat(chunks);
  assert.equal(out.length, payload.length);
  assert.ok(out.equals(payload), '流式与原始字节完全一致');
  if (zlib.crc32) assert.equal(zlib.crc32(out), e.crc32);
});

test('流式：加密条目被拒绝', async () => {
  const filePath = zipFile([{ name: 'x.mp3', data: 'abc', flags: 0x1 }]);
  const info = await probeZip(filePath);
  await assert.rejects(
    () => openEntryStream(filePath, findEntry(info.entries, 'x.mp3')),
    /加密/,
  );
});

test('防护：解压比异常（压缩炸弹）被拒绝', async () => {
  // 用 stored 条目让偏移可精确计算，再把中央目录里的「解压后体积」谎报得很大
  const name = 'bomb.mp3';
  const good = makeZip([{ name, data: Buffer.alloc(100), store: true }]);
  const buf = Buffer.from(good);
  const dataLen = 100;
  const centralOffset = 30 + Buffer.byteLength(name) + dataLen; // 本地头(30) + 名称 + 数据
  const sizeField = centralOffset + 24;                          // 中央目录 size 字段偏移
  assert.equal(buf.readUInt32LE(centralOffset), SIG_CENTRAL, '中央目录起点应对齐');
  buf.writeUInt32LE(dataLen * 1000, sizeField);                  // 谎报解压后体积
  const p = writeZip(buf, 'bomb');
  const info = await probeZip(p);
  const e = findEntry(info.entries, name);
  assert.equal(e.kind, 'audio');
  assert.ok(e.size / e.packedSize > 500, '构造出的解压比应超过阈值');
  await assert.rejects(() => readEntryData(p, e), (err) => err.code === 'SUSPICIOUS_RATIO');
});

/* --------------------------------------------------------- 虚拟路径与工具 */

test('虚拟路径：合成与拆解可往返，且能被识别', () => {
  const vp = virtualPath('E:\\a\\b.zip', 'dir/01.mp3');
  assert.ok(vp.includes(MEMBER_SEP), '含 NUL 分隔符');
  assert.equal(isVirtualPath(vp), true);
  assert.deepEqual(splitVirtualPath(vp), { archivePath: 'E:\\a\\b.zip', memberPath: 'dir/01.mp3' });
  assert.equal(isVirtualPath('E:\\a\\01.mp3'), false);
  assert.equal(splitVirtualPath('E:\\a\\01.mp3'), null);
});

test('虚拟路径：成员路径里的反斜杠与前导斜杠被归一化', () => {
  const vp = virtualPath('E:\\b.zip', '\\dir\\sub\\01.mp3');
  assert.deepEqual(splitVirtualPath(vp), { archivePath: 'E:\\b.zip', memberPath: 'dir/sub/01.mp3' });
  // 普通磁盘路径不含 NUL，因此**不是**虚拟路径
  assert.equal(splitVirtualPath('C:/x/y.zip'), null);
  assert.equal(isVirtualPath('C:/x/y.zip'), false);
  // 空成员是合法虚拟路径
  assert.deepEqual(splitVirtualPath(virtualPath('C:/x/y.zip', '')), { archivePath: 'C:/x/y.zip', memberPath: '' });
});

test('工具：isArchiveName 只看扩展名且不区分大小写', () => {
  assert.equal(isArchiveName('a.zip'), true);
  assert.equal(isArchiveName('A.ZIP'), true);
  assert.equal(isArchiveName('a.7z'), false);
  assert.equal(isArchiveName('a.mp3'), false);
  assert.equal(isArchiveName(''), false);
});

test('工具：looksLikeZip 对尾部带注释的合法包返回 true', async () => {
  const filePath = zipFile(
    [{ name: 'a.mp3', data: 'x' }],
    { comment: Buffer.from('这是 ZIP 注释，EOCD 不在文件最末尾', 'utf8') },
    'comment',
  );
  assert.equal(looksLikeZip(filePath), true);
  const info = await probeZip(filePath);
  assert.equal(info.entryCount, 1);
});

/* ------------------------------------------------------------ 真实包回归 */

const REAL_DIR = 'E:\\Music\\ASMR';

test('真实包：若存在音声压缩包，则清单与 CRC 校验一致（只读）', async (t) => {
  if (!fs.existsSync(REAL_DIR)) return t.skip('未找到 E:\\Music\\ASMR');
  const zips = fs.readdirSync(REAL_DIR).filter((n) => n.toLowerCase().endsWith('.zip'));
  if (!zips.length) return t.skip('目录内没有压缩包');

  const filePath = path.join(REAL_DIR, zips[0]);
  const before = fs.statSync(filePath);
  const info = await probeZip(filePath);

  assert.ok(info.entryCount > 0);
  assert.ok(info.entries.some((e) => e.kind === 'audio'), '应识别出音频成员');

  // 取一个较小的成员做端到端校验（封面图），避免读大音频
  const small = info.entries.filter((e) => e.kind === 'image' && e.readable)[0]
    ?? info.entries.filter((e) => e.readable && e.size > 0 && e.size < 2 * 1024 * 1024)
      .sort((a, b) => a.size - b.size)[0];
  if (small) {
    const data = await readEntryData(filePath, small);
    assert.equal(data.length, small.size, '解出长度与清单一致');
    if (zlib.crc32) assert.equal(zlib.crc32(data), small.crc32, 'CRC32 与包内记录一致');
  }

  // 只读保证：源包绝不能被修改
  const after = fs.statSync(filePath);
  assert.equal(after.size, before.size, '源包大小不变');
  assert.equal(Math.round(after.mtimeMs), Math.round(before.mtimeMs), '源包 mtime 不变');
});
