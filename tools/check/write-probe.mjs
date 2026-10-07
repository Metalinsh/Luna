/**
 * 写入安全探针（人工/可选运行，需要本机有真实音乐库）。
 *
 *   node tools/write-probe.mjs
 *
 * 做三件事，全程只操作临时目录里的副本，绝不碰原文件：
 *   1) 用真实 Hi-Res FLAC 验证写入标签、覆盖写入、写入内嵌封面
 *   2) 每次写入后比对 FLAC 音频数据段的 SHA-256 —— 证明写标签不会改动音频
 *   3) 用 music-metadata 回读，确认字段生效且时长/编码/位深未变
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { parseFile } from 'music-metadata';

import { writeTags, canWrite } from '../../server/writers.mjs';

const BASE = process.env.LAM_BASE ?? 'http://127.0.0.1:8787';
let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? `  (${extra})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

function flacAudioOffset(buf) {
  if (buf.subarray(0, 4).toString('latin1') !== 'fLaC') return null;
  let offset = 4;
  while (offset + 4 <= buf.length) {
    const header = buf[offset];
    const isLast = (header & 0x80) !== 0;
    const length = (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
    offset += 4 + length;
    if (isLast) break;
  }
  return offset;
}

function flacAudioHash(file) {
  const buf = fs.readFileSync(file);
  const offset = flacAudioOffset(buf);
  if (offset === null) return null;
  return {
    hash: crypto.createHash('sha256').update(buf.subarray(offset)).digest('hex'),
    audioBytes: buf.length - offset,
  };
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-write-probe-'));

try {
  const albums = (await (await fetch(`${BASE}/api/albums?limit=100`)).json()).albums;
  // 音声发行的 tracks 是按轨号合并后的行（没有 path），探针只用普通音乐专辑
  const musicAlbum = albums.find((a) => !a.is_voice && a.track_count > 0) ?? albums[0];
  const detail = await (await fetch(`${BASE}/api/albums/${musicAlbum.id}`)).json();
  const source = detail.tracks[0]?.path;
  if (!source) throw new Error('库里没有可用于写入探针的普通音乐曲目');
  const target = path.join(work, `copy${path.extname(source)}`);
  await fsp.copyFile(source, target);

  const ext = path.extname(source).toLowerCase();
  console.log(`素材：${path.basename(source)}（${(fs.statSync(target).size / 1048576).toFixed(1)} MB）`);
  ok('该格式被写入器支持', canWrite(ext), ext);

  const before = await parseFile(target, { duration: true });
  const audioBefore = flacAudioHash(target);
  console.log(`      ${before.format.codec} / ${before.format.bitsPerSample}bit / `
    + `${before.format.sampleRate}Hz / ${before.format.numberOfChannels}ch`);
  if (audioBefore) {
    console.log(`      音频段 ${audioBefore.audioBytes} 字节，SHA-256 ${audioBefore.hash.slice(0, 16)}…`);
  }

  console.log('\n— 写入标签 —');
  const applied = writeTags(target, {
    genres: ['电子', '探针写入'],
    year: 2020,
    comment: 'write-probe',
  });
  ok('写入未抛异常', applied.length === 3, applied.join(','));
  const afterWrite = await parseFile(target, { duration: true });
  const audioAfterWrite = flacAudioHash(target);
  if (audioBefore) {
    ok('音频数据段逐字节未变', audioAfterWrite.hash === audioBefore.hash,
      audioAfterWrite.hash === audioBefore.hash ? 'SHA-256 一致' : '不一致！');
  }
  ok('时长未变', Math.abs((afterWrite.format.duration ?? 0) - (before.format.duration ?? 0)) < 0.02,
    `${before.format.duration?.toFixed(2)}s → ${afterWrite.format.duration?.toFixed(2)}s`);
  ok('编码/位深/采样率未变',
    afterWrite.format.codec === before.format.codec
    && afterWrite.format.bitsPerSample === before.format.bitsPerSample
    && afterWrite.format.sampleRate === before.format.sampleRate);
  ok('流派写入并读回', (afterWrite.common.genre ?? []).includes('探针写入'),
    JSON.stringify(afterWrite.common.genre));
  ok('年份写入并读回', afterWrite.common.year === 2020, String(afterWrite.common.year));
  ok('原有标题/专辑保留', Boolean(afterWrite.common.title && afterWrite.common.album),
    `${afterWrite.common.title} / ${afterWrite.common.album}`);

  console.log('\n— 覆盖写入 —');
  writeTags(target, { genres: ['电子'] });
  const after2 = await parseFile(target, { duration: true });
  const audioAfter2 = flacAudioHash(target);
  ok('二次写入结果正确', JSON.stringify(after2.common.genre) === JSON.stringify(['电子']),
    JSON.stringify(after2.common.genre));
  if (audioBefore) ok('二次写入后音频段仍不变', audioAfter2.hash === audioBefore.hash);

  console.log('\n— 写入内嵌封面 —');
  const coverHash = detail.album.cover_hash
    ?? (detail.album.cover_url ? detail.album.cover_url.split('/').pop() : null);
  if (coverHash) {
    const coverBuf = Buffer.from(await (await fetch(`${BASE}/api/cover/${coverHash}`)).arrayBuffer());
    writeTags(target, { picture: { data: coverBuf, mimeType: 'image/jpeg', description: 'front' } });
    const after3 = await parseFile(target, { duration: true, skipCovers: false });
    const audioAfter3 = flacAudioHash(target);
    ok('内嵌封面可读回', (after3.common.picture?.length ?? 0) >= 1,
      `${after3.common.picture?.[0]?.format} ${after3.common.picture?.[0]?.data?.length ?? 0} 字节`);
    if (audioBefore) ok('写封面后音频段仍不变', audioAfter3.hash === audioBefore.hash);
  } else {
    ok('内嵌封面测试（该专辑无封面，跳过）', true, 'skip');
  }

  console.log('\n— 清空字段 —');
  writeTags(target, { genres: null });
  const after4 = await parseFile(target, { duration: true });
  ok('显式清空生效', (after4.common.genre ?? []).length === 0, JSON.stringify(after4.common.genre));
} catch (err) {
  console.log(`\n异常：${err.message}`);
  console.log(String(err.stack).split('\n').slice(1, 4).join('\n'));
  fail += 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
