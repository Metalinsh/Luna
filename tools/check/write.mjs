/**
 * 写回 API 端到端核验（需要服务已启动）。
 *
 *   node tools/write-api-check.mjs
 *
 * 安全设计：先把真实 FLAC 复制到临时目录并**改掉专辑标签**（使其成为独立专辑，
 * 不会与用户真实专辑合并），再登记为临时音乐库，所有写操作只作用于副本；
 * 结束后撤销写入、移除临时库、删除临时目录。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { writeTags } from '../../server/writers.mjs';

const BASE = process.env.LUNA_BASE || 'http://127.0.0.1:8799';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; let fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}${e ? `  (${e})` : ''}`); }
  else { fail++; console.log(`  FAIL  ${n}  ${e}`); }
};

const api = async (p, o) => {
  const r = await fetch(BASE + p, {
    headers: o?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...o,
    body: o?.body ? JSON.stringify(o.body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-write-api-'));
let libraryId = null;

try {
  /* ----------------------------------------------------- 准备隔离的临时库 */

  const userLibs = (await api('/api/libraries')).body.libraries;
  // 写回测试只针对普通音乐专辑（音声发行不参与写回流程）
  const allAlbums = (await api('/api/albums?limit=100')).body.albums;
  const musicAlbum = allAlbums.find((a) => !a.is_voice && a.track_count > 0);
  if (!musicAlbum) throw new Error('库里没有可用于写入测试的普通音乐专辑');
  const detail = (await api(`/api/albums/${musicAlbum.id}`)).body;
  const source = detail.tracks[0]?.path;
  if (!source) throw new Error('该专辑没有可用的曲目文件');

  const albumDir = path.join(tempRoot, 'Write API Album');
  fs.mkdirSync(albumDir, { recursive: true });
  const copy = path.join(albumDir, `01 check${path.extname(source)}`);
  await fsp.copyFile(source, copy);

  // 改成独立专辑，避免与用户真实专辑合并（否则写回会命中真实文件）
  writeTags(copy, {
    album: '写回自检专辑',
    albumArtist: '自检',
    artists: ['自检'],
    title: '写回自检曲目',
  });
  console.log(`临时副本：${path.basename(copy)}（已改为独立专辑「写回自检专辑」）`);
  const originalHash = sha(copy);

  const created = await api('/api/libraries', {
    method: 'POST', body: { path: tempRoot, displayName: '写回自检库', scan: true },
  });
  libraryId = created.body.library.id;
  for (let i = 0; i < 60; i += 1) {
    if (!(await api('/api/scan/status')).body.running) break;
    await sleep(500);
  }

  const checkAlbum = (await api('/api/albums?q=写回自检专辑&limit=5')).body.albums
    .find((a) => a.album === '写回自检专辑');
  ok('临时库已扫描出独立专辑', Boolean(checkAlbum), checkAlbum ? `#${checkAlbum.id}` : '未找到');
  if (!checkAlbum) throw new Error('临时专辑未建立，终止');

  /* ------------------------------------------------------------- 写入器能力 */

  const support = await api('/api/writer/support');
  ok('GET /api/writer/support 返回格式矩阵',
    support.status === 200 && support.body.support.extensions.includes('.flac'),
    `${support.body.support.writer} / ${support.body.support.extensions.length} 种格式`);
  ok('许可信息已登记', /LGPL/.test(support.body.support.license ?? ''), support.body.support.license);

  /* ----------------------------------------------------------------- 预览 */

  const preview = await api(`/api/albums/${checkAlbum.id}/metadata/preview`, {
    method: 'POST',
    body: { scope: 'album', fields: { genres: ['自检流派'], year: 2024 } },
  });
  ok('预览返回影响清单', preview.status === 200 && preview.body.preview.changes.length === 1,
    `将修改 ${preview.body.preview.summary?.files} 个文件`);
  ok('预览标注可写性', preview.body.preview.summary.writable === 1);
  ok('预览不写入文件', sha(copy) === originalHash);

  const invalid = await api(`/api/albums/${checkAlbum.id}/metadata/preview`, {
    method: 'POST', body: { scope: 'album', fields: { year: 999 } },
  });
  ok('越界字段被拒绝（400）', invalid.status === 400, invalid.body.error);

  /* ----------------------------------------------------------------- 写入 */

  const written = await api(`/api/albums/${checkAlbum.id}/metadata`, {
    method: 'POST',
    body: { scope: 'album', fields: { genres: ['自检流派'], year: 2024, comment: 'api-check' } },
  });
  ok('写入请求被接受并返回 jobId', written.status === 202 && written.body.jobId > 0,
    `job #${written.body.jobId}`);

  let job = null;
  for (let i = 0; i < 40; i += 1) {
    job = (await api(`/api/jobs/${written.body.jobId}`)).body.job;
    if (job && ['done', 'failed', 'interrupted'].includes(job.status)) break;
    await sleep(300);
  }
  ok('任务完成', job?.status === 'done', `${job?.status} 成功 ${job?.succeeded} 跳过 ${job?.skipped} 失败 ${job?.failed}`);
  ok('文件内容已改变', sha(copy) !== originalHash);

  const after = (await api(`/api/albums/${checkAlbum.id}`)).body;
  ok('索引已按写回结果同步', after.album.genre === '自检流派' && after.album.year === 2024,
    `${after.album.genre} / ${after.album.year}`);

  const backupFile = job.items[0].backup_file;
  ok('备份文件存在且等于写入前内容', backupFile && fs.existsSync(backupFile)
    && sha(backupFile) === originalHash, backupFile);
  ok('备份位于音乐库根目录下（同卷，零拷贝）',
    String(backupFile).includes('.lam-undo'), path.basename(path.dirname(path.dirname(backupFile))));

  /* ----------------------------------------------------------------- 撤销 */

  const undone = await api(`/api/jobs/${written.body.jobId}/undo`, { method: 'POST', body: {} });
  ok('撤销成功', undone.status === 200 && undone.body.restored === 1, JSON.stringify(undone.body));
  ok('撤销后逐字节还原', sha(copy) === originalHash);
  const afterUndo = (await api(`/api/albums/${checkAlbum.id}`)).body;
  ok('撤销后索引同步回原值', afterUndo.album.year !== 2024 || afterUndo.album.genre !== '自检流派',
    `${afterUndo.album.genre} / ${afterUndo.album.year}`);
  ok('任务被标记为已撤销', (await api(`/api/jobs/${written.body.jobId}`)).body.job.status === 'undone');

  /* ------------------------------------------------------------- 封面写入 */

  console.log('\n— 封面写入 —');
  const coverBytes = detail.album.cover_url
    ? Buffer.from(await (await fetch(`${BASE}${detail.album.cover_url}`)).arrayBuffer())
    : null;
  if (coverBytes) {
    const imageBase64 = coverBytes.toString('base64');
    const { parseFile } = await import('music-metadata');
    const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
    const coverHash = sha1(coverBytes);

    const candidates = await api(`/api/albums/${checkAlbum.id}/cover/candidates`);
    ok('封面候选接口可用', candidates.status === 200 && Array.isArray(candidates.body.folderImages),
      `目录图片 ${candidates.body.folderImages.length} 张`);

    const setRes = await api(`/api/albums/${checkAlbum.id}/cover`, {
      method: 'POST', body: { imageBase64, mode: 'embedded' },
    });
    ok('内嵌封面写入请求被接受', setRes.status === 202 && setRes.body.jobId > 0,
      `job #${setRes.body.jobId} · ${setRes.body.files} 个文件`);
    for (let i = 0; i < 40; i += 1) {
      const j = (await api(`/api/jobs/${setRes.body.jobId}`)).body.job;
      if (j && ['done', 'failed'].includes(j.status)) break;
      await sleep(300);
    }
    const coverJob = (await api(`/api/jobs/${setRes.body.jobId}`)).body.job;
    ok('内嵌封面写入完成', coverJob.status === 'done' && coverJob.succeeded === 1,
      `成功 ${coverJob.succeeded} 失败 ${coverJob.failed}`
      + (coverJob.items[0]?.error ? ` · ${coverJob.items[0].error}` : ''));

    const meta = await parseFile(copy, { duration: false, skipCovers: false });
    const embeddedHash = meta.common.picture?.[0]?.data
      ? sha1(Buffer.from(meta.common.picture[0].data)) : null;
    ok('文件内嵌封面正是我们写入的那张图', embeddedHash === coverHash,
      `${meta.common.picture?.[0]?.format} ${meta.common.picture?.[0]?.data?.length ?? 0} 字节`);

    const folderRes = await api(`/api/albums/${checkAlbum.id}/cover`, {
      method: 'POST', body: { imageBase64, mode: 'folder' },
    });
    ok('目录封面写入请求被接受', folderRes.status === 202, folderRes.body.target);
    for (let i = 0; i < 40; i += 1) {
      const j = (await api(`/api/jobs/${folderRes.body.jobId}`)).body.job;
      if (j && ['done', 'failed'].includes(j.status)) break;
      await sleep(300);
    }
    const folderFile = path.join(albumDir, 'cover.jpg');
    ok('cover.jpg 已写入专辑目录', fs.existsSync(folderFile)
      && fs.readFileSync(folderFile).length === coverBytes.length, folderFile);

    const removeRes = await api(`/api/albums/${checkAlbum.id}/cover`, {
      method: 'DELETE', body: { mode: 'folder' },
    });
    ok('移除目录封面请求被接受', removeRes.status === 202, `删除 ${removeRes.body.deleted} 个文件`);
    for (let i = 0; i < 40; i += 1) {
      const j = (await api(`/api/jobs/${removeRes.body.jobId}`)).body.job;
      if (j && ['done', 'failed'].includes(j.status)) break;
      await sleep(300);
    }
    ok('cover.jpg 已移除', !fs.existsSync(folderFile));

    const undoCover = await api(`/api/jobs/${removeRes.body.jobId}/undo`, { method: 'POST', body: {} });
    ok('移除封面可撤销（cover.jpg 恢复）', undoCover.status === 200 && fs.existsSync(folderFile));
    fs.rmSync(folderFile, { force: true });

    // 清理内嵌封面
    const clearEmbedded = await api(`/api/albums/${checkAlbum.id}/cover`, {
      method: 'DELETE', body: { mode: 'embedded' },
    });
    for (let i = 0; i < 40; i += 1) {
      const j = (await api(`/api/jobs/${clearEmbedded.body.jobId}`)).body.job;
      if (j && ['done', 'failed'].includes(j.status)) break;
      await sleep(300);
    }
    const cleared = await parseFile(copy, { duration: false, skipCovers: false });
    ok('内嵌封面可移除', (cleared.common.picture?.length ?? 0) === 0);
  } else {
    ok('封面写入测试（无可用封面素材，跳过）', true, 'skip');
  }

  /* ----------------------------------------------------------- 只读保护检查 */

  const userAlbumAfter = (await api(`/api/albums/${musicAlbum.id}`)).body;
  ok('用户真实专辑未被改动', userAlbumAfter.album.id === musicAlbum.id
    && userAlbumAfter.album.album === musicAlbum.album, musicAlbum.album);
  ok('用户真实库仍在', (await api('/api/libraries')).body.libraries.some((l) => l.path === userLibs[0].path));
} catch (err) {
  console.log(`\n异常：${err.message}`);
  fail += 1;
} finally {
  console.log('\n— 清理 —');
  try {
    if (libraryId) await api(`/api/libraries/${libraryId}`, { method: 'DELETE' });
    await fsp.rm(tempRoot, { recursive: true, force: true });
    console.log('  临时库与临时目录已移除');
  } catch (err) {
    console.log(`  清理失败：${err.message}`);
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
