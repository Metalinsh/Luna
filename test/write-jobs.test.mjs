/**
 * 写操作安全框架测试（设计文档 5.3 / 10.3 验收标准）。
 *
 * 用 ffmpeg 生成真实音频素材（本机没有可用 ffmpeg 时逐项跳过），覆盖：
 * 成功写入、原子性（崩溃时原文件不变）、写后校验拦截、乐观锁冲突、
 * 撤销还原、中断恢复、临时文件清理、编辑计划与字段校验、写锁。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-write-data-'));
const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-write-music-'));
const pcmFile = path.join(os.tmpdir(), `lam-zeros-${process.pid}.pcm`);
process.env.LAM_DATA_DIR = dataDir;

const FFMPEG_CANDIDATES = [
  process.env.LAM_FFMPEG,
  'ffmpeg',
  'C:\\Program Files\\Cooler Master\\MasterControl\\ffmpeg-cli\\ffmpeg.exe',
  'C:\\Program Files\\Softdeluxe\\Free Download Manager\\ffmpeg.exe',
].filter(Boolean);

function findFfmpeg() {
  for (const candidate of FFMPEG_CANDIDATES) {
    try {
      execFileSync(candidate, ['-version'], { stdio: 'ignore' });
      return candidate;
    } catch { /* 试下一个 */ }
  }
  return null;
}

const ffmpeg = findFfmpeg();
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

let store;
let writeJobs;
let libraryId = null;
let seq = 0;

before(async () => {
  store = await import('../server/db.mjs');
  writeJobs = await import('../server/write-jobss.mjs').catch(() => import('../server/write-jobs.mjs'));
  // 1 秒 44.1kHz 立体声静音的原始 PCM，作为素材来源
  fs.writeFileSync(pcmFile, Buffer.alloc(44100 * 2 * 2));
  libraryId = store.addLibrary(musicDir, '写测试库').id;
});

after(() => {
  try { store?.closeDb(); } catch { /* 忽略 */ }
  for (const dir of [dataDir, musicDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 上可能仍被占用 */ }
  }
  try { fs.rmSync(pcmFile, { force: true }); } catch { /* 忽略 */ }
});

/** 用 ffmpeg 造一个真实音频文件；失败返回 null（调用方跳过） */
function makeFixture(codec) {
  if (!ffmpeg) return null;
  const target = path.join(musicDir, `fixture-${seq += 1}.${codec}`);
  const codecArgs = {
    flac: ['-c:a', 'flac'],
    wav: ['-c:a', 'pcm_s16le'],
    aiff: ['-c:a', 'pcm_s16be'],
    mp3: ['-c:a', 'libmp3lame', '-b:a', '128k'],
    m4a: ['-c:a', 'aac', '-b:a', '128k'],
  }[codec];
  const attempts = [codecArgs];
  if (codec === 'mp3') attempts.push(['-c:a', 'mp3_mf', '-b:a', '128k']);
  for (const args of attempts) {
    try {
      execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error',
        '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', pcmFile,
        '-y', ...args, target], { stdio: 'ignore' });
      if (fs.existsSync(target) && fs.statSync(target).size > 100) return target;
    } catch { /* 换下一个编码器 */ }
  }
  return null;
}

/** 把文件登记成一条曲目记录（模拟扫描结果） */
function register(filePath, { album = '写测试专辑', title = '写测试曲目', trackNo = 1 } = {}) {
  const stat = fs.statSync(filePath);
  const dir = path.dirname(filePath);
  const resolved = store.resolveAlbumForTrack({
    album, artist: '写测试艺术家', albumArtist: '写测试艺术家', dir,
  });
  store.upsertTrack({
    path: filePath, dir, libraryId,
    filename: path.basename(filePath),
    ext: path.extname(filePath).toLowerCase(),
    size: stat.size, mtime: Math.round(stat.mtimeMs),
    title, titleSource: 'tag',
    artist: '写测试艺术家', albumArtist: '写测试艺术家', album,
    albumKey: resolved.albumKey, albumId: resolved.albumId,
    trackNo, hasCover: false,
  });
  return store.findTrackByPath(filePath);
}

function enqueue(plan) {
  return writeJobs.createJob({
    type: 'metadata', items: plan.items,
    payload: { patches: plan.patches, snapshots: plan.snapshots },
  });
}

/* ------------------------------------------------------------ 计划与校验 */

test('字段校验：空曲名、越界年份、越界音轨号、过长流派都被拒绝', () => {
  assert.equal(writeJobs.validateFields({ title: '' }).ok, false);
  assert.equal(writeJobs.validateFields({ year: 999 }).ok, false);
  assert.equal(writeJobs.validateFields({ year: 2020 }).ok, true);
  assert.equal(writeJobs.validateFields({ trackNo: 0 }).ok, false);
  assert.equal(writeJobs.validateFields({ genres: ['x'.repeat(61)] }).ok, false);
  assert.equal(writeJobs.validateFields({ album: '' }).ok, false);
});

test('编辑计划：不存在的专辑报错', () => {
  const plan = writeJobs.planMetadataEdit({ albumId: 999999, fields: { year: 2000 } });
  assert.equal(plan.ok, false);
});

/* --------------------------------------------------------------- 写入流程 */

test('写入：真实 FLAC 写入成功、备份 = 写入前内容、索引同步', async (t) => {
  const file = makeFixture('flac');
  if (!file) return t.skip('本机没有可用的 ffmpeg');

  const track = register(file);
  const beforeHash = sha(file);

  const plan = writeJobs.planMetadataEdit({
    trackId: track.id, scope: 'track', fields: { genres: ['爵士'], year: 1999, comment: '框架测试' },
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.summary.writable, 1);

  const stats = await writeJobs.runJob(enqueue(plan));
  assert.deepEqual(stats, { succeeded: 1, skipped: 0, failed: 0 });

  const job = writeJobs.getJob(stats.jobId ?? (await writeJobs.listJobs({ limit: 1 }))[0].id);
  assert.equal(job.status, 'done');
  assert.ok(job.items[0].backup_file && fs.existsSync(job.items[0].backup_file), '备份文件存在');
  assert.equal(sha(job.items[0].backup_file), beforeHash, '备份内容 = 写入前的原文件');

  const { parseFile } = await import('music-metadata');
  const meta = await parseFile(file, { duration: false });
  assert.deepEqual(meta.common.genre, ['爵士']);
  assert.equal(meta.common.year, 1999);

  const refreshed = store.getTrack(track.id);
  assert.equal(refreshed.genre, '爵士');
  assert.equal(refreshed.year, 1999);
  fs.rmSync(file, { force: true });
});

test('写入：MP3/ID3 同样成功', async (t) => {
  const file = makeFixture('mp3');
  if (!file) return t.skip('本机 ffmpeg 不支持 MP3 编码');

  const track = register(file, { album: 'MP3 专辑' });
  const plan = writeJobs.planMetadataEdit({
    trackId: track.id, scope: 'track', fields: { genres: ['摇滚'], year: 2001 },
  });
  const stats = await writeJobs.runJob(enqueue(plan));
  assert.equal(stats.succeeded, 1);

  const { parseFile } = await import('music-metadata');
  const meta = await parseFile(file, { duration: false });
  assert.deepEqual(meta.common.genre, ['摇滚']);
  fs.rmSync(file, { force: true });
});

test('原子性：写入器崩溃时原文件字节不变、无临时文件残留', async (t) => {
  const file = makeFixture('flac');
  if (!file) return t.skip('本机没有可用的 ffmpeg');

  const track = register(file, { album: '原子性专辑' });
  const beforeHash = sha(file);
  const plan = writeJobs.planMetadataEdit({ trackId: track.id, scope: 'track', fields: { genres: ['X'] } });

  const stats = await writeJobs.runJob(enqueue(plan), {
    writer: () => { throw new Error('模拟写入器崩溃'); },
  });

  assert.equal(stats.failed, 1);
  assert.equal(sha(file), beforeHash, '原文件内容未变');
  assert.deepEqual(fs.readdirSync(musicDir).filter((f) => f.startsWith('.lam-tmp-')), [],
    '没有临时文件残留');
  fs.rmSync(file, { force: true });
});

test('写后校验：写入器没真正写进去时判定失败，原文件保持不变', async (t) => {
  const file = makeFixture('flac');
  if (!file) return t.skip('本机没有可用的 ffmpeg');

  const track = register(file, { album: '校验专辑' });
  const beforeHash = sha(file);
  const plan = writeJobs.planMetadataEdit({ trackId: track.id, scope: 'track', fields: { genres: ['应当失败'] } });
  const jobId = enqueue(plan);

  const stats = await writeJobs.runJob(jobId, { writer: () => [] });

  assert.equal(stats.failed, 1);
  assert.match(writeJobs.getJob(jobId).items[0].error ?? '', /校验不一致/);
  assert.equal(sha(file), beforeHash, '原文件未被替换');
  fs.rmSync(file, { force: true });
});

test('乐观锁：编辑期间文件被外部修改 → 跳过且不覆盖外部改动', async (t) => {
  const file = makeFixture('flac');
  if (!file) return t.skip('本机没有可用的 ffmpeg');

  const track = register(file, { album: '乐观锁专辑' });
  const plan = writeJobs.planMetadataEdit({ trackId: track.id, scope: 'track', fields: { genres: ['冲突'] } });

  fs.appendFileSync(file, Buffer.alloc(8));
  const afterExternal = sha(file);

  const jobId = enqueue(plan);
  const stats = await writeJobs.runJob(jobId);

  assert.equal(stats.skipped, 1);
  assert.match(writeJobs.getJob(jobId).items[0].error ?? '', /外部修改/);
  assert.equal(sha(file), afterExternal, '外部改动被保留');
  fs.rmSync(file, { force: true });
});

test('撤销：逐字节还原到写入前状态，任务标记为 undone', async (t) => {
  const file = makeFixture('flac');
  if (!file) return t.skip('本机没有可用的 ffmpeg');

  const track = register(file, { album: '撤销专辑' });
  const beforeHash = sha(file);
  const plan = writeJobs.planMetadataEdit({ trackId: track.id, scope: 'track', fields: { genres: ['待撤销'] } });
  const jobId = enqueue(plan);
  await writeJobs.runJob(jobId);
  assert.notEqual(sha(file), beforeHash, '写入已生效');

  const result = await writeJobs.undoJob(jobId);
  assert.equal(result.restored, 1);
  assert.equal(sha(file), beforeHash, '撤销后与写入前逐字节一致');
  assert.equal(writeJobs.getJob(jobId).status, 'undone');
  fs.rmSync(file, { force: true });
});

test('不支持写回的格式被跳过并说明原因', async (t) => {
  const file = makeFixture('wav');
  if (!file) return t.skip('本机没有可用的 ffmpeg');

  const dsf = path.join(musicDir, `fake-${seq += 1}.dsf`);
  fs.copyFileSync(file, dsf);
  fs.rmSync(file, { force: true });

  const track = register(dsf, { album: '不支持专辑' });
  const plan = writeJobs.planMetadataEdit({ trackId: track.id, scope: 'track', fields: { genres: ['X'] } });
  const jobId = enqueue(plan);
  const stats = await writeJobs.runJob(jobId);

  assert.equal(stats.skipped, 1);
  assert.match(writeJobs.getJob(jobId).items[0].error ?? '', /不支持写回/);
  fs.rmSync(dsf, { force: true });
});

test('写锁：执行期间拒绝并发写任务', async (t) => {
  const file = makeFixture('flac');
  if (!file) return t.skip('本机没有可用的 ffmpeg');

  const track = register(file, { album: '写锁专辑' });
  const plan = writeJobs.planMetadataEdit({ trackId: track.id, scope: 'track', fields: { genres: ['锁'] } });
  const jobId = enqueue(plan);

  let sawBusy = false;
  const running = writeJobs.runJob(jobId, {
    writer: (p, patch) => {
      sawBusy = writeJobs.isWriting();
      // 直接返回空表示不写，让校验失败，不影响本用例关注点
      return [];
    },
  });
  await running.catch(() => {});
  assert.equal(sawBusy, true, '执行期间处于写锁定状态');
  assert.equal(writeJobs.isWriting(), false, '结束后释放写锁');

  let rejected = false;
  const lockCheck = writeJobs.runJob(-1).catch((err) => { rejected = err.code === 'WRITE_BUSY'; });
  await lockCheck;
  assert.equal(rejected, false, '空闲时不会误报 WRITE_BUSY');
  fs.rmSync(file, { force: true });
});

test('中断恢复：原路径缺失 + 备份存在 → 自动还原', async (t) => {
  const file = makeFixture('flac');
  if (!file) return t.skip('本机没有可用的 ffmpeg');

  const track = register(file, { album: '恢复专辑' });
  const originalHash = sha(file);

  const backupDir = path.join(musicDir, '.lam-undo', '9999');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, '0.flac');
  fs.copyFileSync(file, backupFile);
  fs.rmSync(file);

  const info = store.db.prepare(`
    INSERT INTO write_jobs (type, status, total, created_at) VALUES ('metadata', 'interrupted', 1, ?)
  `).run(Date.now());
  store.db.prepare(`
    INSERT INTO write_job_items (job_id, track_id, path, status, backup_file)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(Number(info.lastInsertRowid), track.id, file, backupFile);

  const report = await writeJobs.recoverInterruptedWrites();
  assert.ok(report.restored >= 1, `恢复了 ${report.restored} 个文件`);
  assert.ok(fs.existsSync(file), '原路径已恢复');
  assert.equal(sha(file), originalHash, '恢复内容与原来一致');
  fs.rmSync(file, { force: true });
});

test('临时文件清理：清掉遗留的 .lam-tmp-*', async () => {
  const stray = path.join(musicDir, '.lam-tmp-123-0.flac');
  fs.writeFileSync(stray, Buffer.alloc(16));
  const removed = await writeJobs.cleanupTempFiles(musicDir);
  assert.ok(removed >= 1);
  assert.equal(fs.existsSync(stray), false);
});
