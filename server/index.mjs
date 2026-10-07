import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

import express from 'express';

import {
  PUBLIC_DIR, COVER_DIR, THUMB_DIR, DATA_DIR, MIME_BY_EXT, readConfig, writeConfig, ensureDirs,
} from './config.mjs';
import * as store from './db.mjs';
import * as tagsApi from './tags.mjs';
import * as completeness from './completeness.mjs';
import * as assets from './assets.mjs';
import * as lyricsApi from './lyrics.mjs';
import * as maintenance from './maintenance.mjs';
import { analyzeRelease } from './asmr.mjs';

/** 视频轨要用 video/* 才能被浏览器的 <video> 播放 */
const VIDEO_MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
};
import * as writeJobs from './write-jobs.mjs';
import * as writers from './writers.mjs';
import {
  scanState, startScan, cancelScan, isScanning, lastScanReport,
} from './scanner.mjs';

ensureDirs();
const config = readConfig();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32mb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* 用户资产变更后延迟落盘一次自动备份（3 秒合并窗口） */
let backupTimer = null;
function scheduleAssetBackup(reason) {
  if (backupTimer) return;
  backupTimer = setTimeout(() => {
    backupTimer = null;
    assets.writeAutoBackup(reason);
  }, 3000);
  backupTimer.unref?.();
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

const parseId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/* ------------------------------------------------------------------- health */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: '2.1.0',
    schemaVersion: store.SCHEMA_VERSION,
    node: process.version,
    dataDir: DATA_DIR,
    uptime: process.uptime(),
    migration: store.migrationReport,
  });
});

app.get('/api/stats', (req, res) => {
  res.json({
    stats: store.getStats(),
    completeness: completeness.incompleteSummary(),
    libraries: store.listLibraries(),
    lastBackupAt: assets.lastBackupAt(),
  });
});

/* ---------------------------------------------------------------- libraries */

app.get('/api/libraries', (req, res) => {
  res.json({ libraries: store.listLibraries() });
});

app.post('/api/libraries', asyncRoute(async (req, res) => {
  const raw = String(req.body?.path ?? '').trim().replace(/^"|"$/g, '');
  if (!raw) return badRequest(res, '缺少目录路径');

  const target = path.resolve(raw);
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch (err) {
    return badRequest(res, `目录不存在或不可访问：${err.code ?? err.message}`);
  }
  if (!stat.isDirectory()) return badRequest(res, '路径不是目录');

  const existing = store.findLibraryByPath(target);
  const lib = store.addLibrary(target, req.body?.displayName ?? null);
  if (req.body?.scan !== false && !isScanning()) startScan({ libraryIds: [lib.id] });
  scheduleAssetBackup('library-add');
  res.status(existing ? 200 : 201).json({ library: lib, added: !existing });
}));

app.patch('/api/libraries/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '无效的音乐库 ID');
  if (!store.getLibrary(id)) return res.status(404).json({ error: '音乐库不存在' });

  const name = String(req.body?.displayName ?? '').trim();
  if (name.length > 40) return badRequest(res, '显示名最多 40 个字符');

  const library = store.renameLibrary(id, name);
  scheduleAssetBackup('library-rename');
  res.json({ library });
});

app.delete('/api/libraries/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '无效的音乐库 ID');
  const ok = store.removeLibrary(id);
  if (!ok) return res.status(404).json({ error: '音乐库不存在' });
  scheduleAssetBackup('library-remove');
  res.json({ ok: true });
});

app.post('/api/dialog/folder', asyncRoute(async (req, res) => {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = '选择音乐库目录'",
    '$d.ShowNewFolderButton = $true',
    "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
  ].join('; ');

  const run = (exe) => new Promise((resolve, reject) => {
    execFile(exe, ['-NoProfile', '-STA', '-Command', script], { timeout: 180000 }, (err, stdout) => {
      if (err) reject(err); else resolve(String(stdout ?? '').trim());
    });
  });

  try {
    let picked;
    try {
      picked = await run('powershell.exe');
    } catch {
      picked = await run('pwsh.exe');
    }
    if (!picked) return res.json({ ok: false, cancelled: true });
    res.json({ ok: true, path: picked });
  } catch (err) {
    res.status(500).json({ ok: false, error: `无法打开目录选择框：${err.message}` });
  }
}));

app.post('/api/reveal', (req, res) => {
  const id = Number(req.body?.trackId);
  const track = Number.isFinite(id) ? store.getTrack(id) : null;
  const target = track ? track.path : String(req.body?.path ?? '').trim();
  if (!target) return badRequest(res, '缺少目标路径');
  if (!fs.existsSync(target)) return res.status(404).json({ error: '文件已不存在' });
  execFile('explorer.exe', ['/select,', target], () => { /* explorer 退出码不可靠 */ });
  res.json({ ok: true });
});

/* --------------------------------------------------------------------- scan */

app.post('/api/scan', (req, res) => {
  const libraryIds = Array.isArray(req.body?.libraryIds) ? req.body.libraryIds : null;
  const result = startScan({ libraryIds });
  if (!result.started) return res.status(409).json({ error: '已有扫描任务在进行中', state: scanState });
  res.status(202).json({ state: scanState });
});

app.get('/api/scan/status', (req, res) => {
  res.json({ state: scanState, running: isScanning(), lastReport: lastScanReport() });
});

app.post('/api/scan/cancel', (req, res) => {
  res.json({ cancelled: cancelScan() });
});

/* ------------------------------------------------------------------- albums */

function decorateAlbums(rows) {
  const comp = completeness.completenessMap();
  const tagMap = tagsApi.getTagsForAlbums(rows.map((r) => r.id));
  return rows.map((row) => ({
    ...row,
    tags: tagMap.get(row.id) ?? [],
    completeness: comp.get(row.id) ?? { status: 'complete', missing: [], missingDetailed: [] },
  }));
}

app.get('/api/albums', (req, res) => {
  const q = String(req.query.q ?? '');
  const sort = String(req.query.sort ?? 'artist-asc');
  const limit = Math.min(Number(req.query.limit) || 60, 2000);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const tagIds = String(req.query.tags ?? '').split(',')
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const tagMode = req.query.tagMode === 'or' ? 'or' : 'and';
  const libraryId = parseId(req.query.libraryId);
  const status = ['complete', 'critical', 'advisory'].includes(String(req.query.status))
    ? String(req.query.status) : null;
  const favoriteOnly = req.query.favorite === '1';
  const kind = ['voice', 'music'].includes(String(req.query.kind)) ? String(req.query.kind) : null;

  const rows = store.listAlbums({
    q, sort, limit, offset, tagIds, tagMode, libraryId, status, favoriteOnly, kind,
  });
  const total = store.countAlbumsFiltered({
    q, tagIds, tagMode, libraryId, favoriteOnly, kind,
  });

  res.json({
    albums: decorateAlbums(rows),
    total,
    limit,
    offset,
    hasMore: offset + rows.length < total,
  });
});

app.get('/api/albums/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '无效的专辑 ID');
  const album = store.getAlbumById(id);
  if (!album) return res.status(404).json({ error: '专辑不存在' });

  const tracks = store.listAlbumTracks(id);
  const totalDuration = tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);
  // 详情页与专辑墙使用同一套艺术家显示规则，避免两处不一致
  const displayArtist = store.computeDisplayArtist(
    album.album_artist,
    tracks.map((t) => t.artist),
  );

  const base = {
    id: album.id,
    album_key: album.album_key,
    album: album.display_title,
    album_artist: displayArtist,
    year: album.year,
    genre: album.genre,
    is_compilation: album.is_compilation,
    is_voice: album.is_voice,
    kind: album.kind ?? 'music',
    rj_code: album.rj_code ?? null,
    release_root: album.release_root ?? null,
    has_bonus: album.has_bonus,
    has_video: album.has_video,
    circle: album.circle ?? null,
    artist_source: album.album_artist_source ?? null,
    artist_suggested: album.artist_suggested ?? null,
    artist_decision: album.artist_decision ?? null,
    favorite: Boolean(album.favorite),
    track_count: tracks.length,
    duration_sum: totalDuration,
    cover_url: album.cover_hash ? `/api/cover/${album.cover_hash}` : null,
    cover_source: album.cover_source,
    tags: tagsApi.getAlbumTags(id),
    completeness: completeness.completenessForAlbum(id),
  };

  // 普通音乐专辑：维持原有平铺列表
  if (!album.is_voice) {
    return res.json({
      album: base,
      tracks: tracks.map((t) => ({ ...t, stream_url: `/api/stream/${t.id}` })),
    });
  }

  /* 音声发行：按「版本 + 轨号」合并成轨道行 */
  const versions = store.listAlbumVersions(id);
  const detailed = store.listVoiceTracks(id);
  const rows = new Map();
  for (const t of detailed) {
    const key = `${t.is_bonus ? 'bonus:' : ''}${t.track_key}`;
    if (!rows.has(key)) {
      rows.set(key, {
        key,
        track_no: t.track_no ?? null,
        title: t.title ?? t.filename,
        is_bonus: Boolean(t.is_bonus),
        has_video: false,
        variants: [],
      });
    }
    const row = rows.get(key);
    if (row.track_no == null && t.track_no != null) row.track_no = t.track_no;
    const isVideo = t.file_kind === 'video';
    if (isVideo) row.has_video = true;
    row.variants.push({
      track_id: t.id,
      version_id: t.version_id,
      version_name: t.version_name ?? '默认',
      group_kind: t.group_kind ?? 'main',
      file_kind: t.file_kind ?? 'audio',
      variant_label: t.variant_label ?? null,
      ext: t.ext,
      size: t.size,
      duration: t.duration,
      stream_url: `/api/stream/${t.id}`,
    });
  }
  // 优先版本排在前面，视频版垫底
  const preferred = new Map(versions.map((v) => [v.id, v.preferred_format]));
  const order = new Map(versions.map((v, i) => [v.id, i]));
  for (const row of rows.values()) {
    row.variants.sort((a, b) => (a.file_kind === 'video' ? 1 : 0) - (b.file_kind === 'video' ? 1 : 0)
      || (order.get(a.version_id) ?? 99) - (order.get(b.version_id) ?? 99));
    row.preferred_track_id = row.variants.find((v) => v.file_kind !== 'video'
      && v.ext.replace('.', '') === preferred.get(v.version_id))?.track_id
      ?? row.variants[0]?.track_id ?? null;
  }

  const list = [...rows.values()].sort((a, b) => (a.is_bonus === b.is_bonus
    ? (a.track_no ?? 9999) - (b.track_no ?? 9999)
    : (a.is_bonus ? 1 : -1)));

  const decisions = store.getMergeDecisions(id);
  res.json({
    album: base,
    versions: versions.map((v) => ({
      id: v.id,
      name: v.name,
      name_key: v.name_key,
      group_kind: v.group_kind,
      preferred_format: v.preferred_format,
      file_count: v.file_count,
      total_bytes: v.total_bytes,
      track_count: v.track_count,
    })),
    tracks: list.filter((r) => !r.is_bonus),
    bonus_tracks: list.filter((r) => r.is_bonus),
    merge_decisions: {
      merge: decisions.merge.length,
      separate: decisions.separate.length,
    },
  });
});

/** 文字宽松归一：全角转半角、去空白、小写，用于「文件夹名里含社团名」这类匹配 */
function looseText(s) {
  return String(s ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * 把用户刚填的社团/艺术家自动套用到「名称里包含该文字」的其他音声发行。
 * 例：为 RJ01128508 填「上海飯店」后，文件夹名里同样含「上海飯店」的 RJ01002989 一并填上。
 */
function propagateVoiceField(albumId, value, field) {
  const needle = looseText(value);
  if (!needle) return [];
  const others = store.voiceAlbumsMatching(value, { excludeId: albumId })
    .filter((a) => {
      // 作品名或发行根路径（含文件夹名）任一处包含即可
      return looseText(a.title).includes(needle) || looseText(a.release_root).includes(needle);
    });
  if (!others.length) return [];
  const ids = others.map((a) => a.id);
  if (field === 'circle') store.setAlbumCircleBulk(ids, value);
  else store.setAlbumArtistBulk(ids, value);
  return others.map((a) => ({ id: a.id, title: a.title }));
}

/**
 * 喜欢 / 取消喜欢（纯库内标记，不动任何文件）。
 */
app.post('/api/albums/:id/favorite', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '无效的专辑 ID');
  if (!store.getAlbumById(id)) return res.status(404).json({ error: '专辑不存在' });
  const value = req.body?.value === undefined ? true : Boolean(req.body.value);
  store.setAlbumFavorite(id, value);
  res.json({ ok: true, favorite: value, wrote_files: false });
});

/**
 * 社团名称（音声发行常用）：与艺术家一样只记进库，不写回音频文件。
 */
app.post('/api/albums/:id/circle', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '无效的专辑 ID');
  const album = store.getAlbumById(id);
  if (!album) return res.status(404).json({ error: '专辑不存在' });
  const circle = store.setAlbumCircle(id, req.body?.circle);
  // 音声发行：把社团名自动套用到文件夹名里含该名字的其他作品
  const propagated = album.is_voice && circle ? propagateVoiceField(id, circle, 'circle') : [];
  res.json({ ok: true, circle, propagated, wrote_files: false });
});

/**
 * 音声发行：只把艺术家记进库（R12），**不写回任何音频文件**。
 */
app.post('/api/albums/:id/voice-artist', asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '无效的专辑 ID');
  const album = store.getAlbumById(id);
  if (!album?.is_voice) return badRequest(res, '该专辑不是音声发行');
  const artist = String(req.body?.artist ?? '').trim() || null;
  store.setAlbumArtistManual(id, artist);
  const propagated = artist ? propagateVoiceField(id, artist, 'artist') : [];
  res.json({ ok: true, album_artist: artist, propagated, wrote_files: false });
}));

/**
 * 批量填写艺术家 / 社团 —— **只对音声（ASMR）发行生效**，普通音乐专辑一律跳过。
 * 与单张填写一样：只写库，不碰任何音频文件。
 */
app.post('/api/albums/bulk-voice-meta', (req, res) => {
  const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const ids = rawIds.map((v) => parseId(v)).filter(Boolean);
  if (!ids.length) return badRequest(res, '没有选择专辑');

  const hasArtist = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'artist');
  const hasCircle = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'circle');
  if (!hasArtist && !hasCircle) return badRequest(res, '没有需要填写的字段');

  const voiceIds = [];
  const skipped = [];
  for (const id of ids) {
    const album = store.getAlbumById(id);
    if (!album) continue;
    if (album.is_voice) voiceIds.push(id);
    else skipped.push(album.display_title);
  }
  if (!voiceIds.length) {
    return res.json({ ok: true, updated: 0, skipped, note: '选中的都不是音声发行，未做任何改动' });
  }

  let updated = 0;
  if (hasArtist) updated = Math.max(updated, store.setAlbumArtistBulk(voiceIds, req.body.artist));
  if (hasCircle) updated = Math.max(updated, store.setAlbumCircleBulk(voiceIds, req.body.circle));

  res.json({
    ok: true,
    updated: voiceIds.length,
    skipped,
    artist: hasArtist ? (String(req.body.artist ?? '').trim() || null) : undefined,
    circle: hasCircle ? (String(req.body.circle ?? '').trim() || null) : undefined,
    wrote_files: false,
  });
});

/**
 * 对「标签建议的艺术家」做出选择：
 *   adopted → 采用建议值（只改软件显示，不动文件）
 *   kept    → 保持软件已识别到的艺术家
 * 两种选择都会让提示消失，且重新扫描不再提示。
 */
app.post('/api/albums/:id/artist-decision', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '无效的专辑 ID');
  const album = store.getAlbumById(id);
  if (!album) return res.status(404).json({ error: '专辑不存在' });
  const decision = String(req.body?.decision ?? '');
  if (!['adopted', 'kept'].includes(decision)) return badRequest(res, 'decision 只能是 adopted 或 kept');
  const updated = store.setArtistDecision(id, decision);
  const propagated = decision === 'adopted' && updated.album_artist
    ? propagateVoiceField(id, updated.album_artist, 'artist')
    : [];
  res.json({ ok: true, decision, album_artist: updated.album_artist, propagated, wrote_files: false });
});

/** 音声发行的「待人工确认」问题清单（文件名冲突 + 相似轨道是否合并） */
app.get('/api/albums/:id/issues', asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '无效的专辑 ID');
  const album = store.getAlbumById(id);
  if (!album) return res.status(404).json({ error: '专辑不存在' });
  if (!album.is_voice || !album.release_root) {
    return res.json({ conflicts: [], mergeCandidates: [], ignored: [], stats: null });
  }
  const decisions = store.getMergeDecisions(id);
  const analysis = await analyzeRelease(album.release_root, { readTags: false, decisions });
  res.json({
    conflicts: analysis.conflicts,
    mergeCandidates: analysis.mergeCandidates,
    ignored: analysis.ignored,
    stats: analysis.stats,
  });
}));

/** 人工确认「两行是否同一条轨道」（R10+ 的待确认落地） */
app.post('/api/albums/:id/merge-decision', asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '无效的专辑 ID');
  const album = store.getAlbumById(id);
  if (!album?.is_voice) return badRequest(res, '该专辑不是音声发行');

  const { keyA, keyB, decision } = req.body ?? {};
  if (!keyA || !keyB) return badRequest(res, '缺少待确认的两条轨道标识');
  if (!['merge', 'separate'].includes(decision)) return badRequest(res, 'decision 只能是 merge 或 separate');

  store.setMergeDecision(id, String(keyA), String(keyB), decision);
  // 结论需要重新解析该发行才能生效
  const result = await rescanRelease(album.release_root);
  res.json({ ok: true, ...result });
}));

/**
 * 重新解析单个音声发行（不触碰其它专辑）。
 * 供「合并结论」生效与手动刷新使用。
 */
async function rescanRelease(releaseRoot) {
  const lib = store.listLibraries().find(
    (l) => releaseRoot.toLowerCase().startsWith(l.path.toLowerCase()),
  );
  if (!lib) throw new Error('找不到该发行所属的音乐库');
  const scan = await import('./scanner.mjs');
  return scan.rescanReleaseRoot({ releaseRoot, libraryId: lib.id });
}

app.get('/api/albums/:id/completeness', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '无效的专辑 ID');
  const info = completeness.completenessForAlbum(id);
  if (!info) return res.status(404).json({ error: '专辑不存在' });
  res.json({ completeness: info });
});

app.post('/api/albums/:id/ignore', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '无效的专辑 ID');
  const key = String(req.body?.key ?? '');
  try {
    const ignored = completeness.ignoreMissing(id, key, Boolean(req.body?.restore));
    scheduleAssetBackup('completeness-ignore');
    res.json({ completeness: completeness.completenessForAlbum(id), ignored });
  } catch (err) {
    badRequest(res, err.message);
  }
});

app.post('/api/albums/:id/compilation', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '无效的专辑 ID');
  if (!store.getAlbumById(id)) return res.status(404).json({ error: '专辑不存在' });
  store.setAlbumCompilation(id, Boolean(req.body?.value));
  res.json({ album: store.getAlbumById(id), completeness: completeness.completenessForAlbum(id) });
});

/* ------------------------------------------------------------------- tracks */

app.get('/api/tracks', (req, res) => {
  const q = String(req.query.q ?? '');
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const libraryId = parseId(req.query.libraryId);
  // 默认只列普通音乐曲目；音声发行走专辑详情里的三层视图
  const includeVoice = req.query.includeVoice === '1';
  const favoriteOnly = req.query.favorite === '1';
  const tracks = store.listLooseTracks({
    q, limit, offset, libraryId, includeVoice, favoriteOnly,
  });
  res.json({
    tracks: tracks.map((t) => ({
      ...t,
      favorite: Boolean(t.favorite),
      stream_url: `/api/stream/${t.id}`,
      cover_url: t.cover_hash ? `/api/cover/${t.cover_hash}` : null,
    })),
    total: store.countLooseTracks({ q, libraryId, includeVoice, favoriteOnly }),
    limit,
    offset,
    hasMore: tracks.length === limit,
  });
});

/**
 * 单曲喜欢（只对普通音乐曲目生效；音声曲目不收录）。
 */
app.post('/api/tracks/:id/favorite', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '无效的曲目 ID');
  const value = req.body?.value === undefined ? true : Boolean(req.body.value);
  const result = store.setTrackFavorite(id, value);
  if (!result.ok) return res.status(404).json({ error: '曲目不存在' });
  res.json({
    ok: true,
    skipped: Boolean(result.skipped),
    favorite: result.favorite,
    note: result.skipped ? '音声曲目不参与单曲收藏' : undefined,
    wrote_files: false,
  });
});

/** 三个收藏入口的数量（侧栏角标用） */
app.get('/api/favorites/summary', (req, res) => {
  res.json({
    asmr: store.countAlbumsFiltered({ favoriteOnly: true, kind: 'voice' }),
    albums: store.countAlbumsFiltered({ favoriteOnly: true, kind: 'music' }),
    tracks: store.countFavoriteTracks(),
  });
});

/* ------------------------------------------------------------------- lyrics */

app.get('/api/tracks/:id/lyrics', asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '无效的曲目 ID');
  const track = store.getTrack(id);
  if (!track) return res.status(404).json({ error: '曲目不存在' });

  const albumTracks = track.album_id ? store.listAlbumTracks(track.album_id) : [];
  const lyrics = await lyricsApi.getLyricsForTrack(track, albumTracks);
  res.json({
    trackId: id,
    title: track.title,
    artist: track.artist,
    ...lyrics,
  });
}));

/* --------------------------------------------------------------------- tags */

app.get('/api/tags', (req, res) => {
  res.json({ tags: tagsApi.listTags({ sort: String(req.query.sort ?? 'usage') }) });
});

app.post('/api/tags', (req, res) => {
  try {
    const tag = tagsApi.createTag(req.body?.name, req.body?.color);
    scheduleAssetBackup('tag-create');
    res.status(201).json({ tag });
  } catch (err) {
    badRequest(res, err.message);
  }
});

app.patch('/api/tags/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '无效的标签 ID');
  try {
    const tag = tagsApi.updateTag(id, req.body ?? {});
    scheduleAssetBackup('tag-update');
    res.json({ tag });
  } catch (err) {
    badRequest(res, err.message);
  }
});

app.delete('/api/tags/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '无效的标签 ID');
  const ok = tagsApi.deleteTag(id);
  if (!ok) return res.status(404).json({ error: '标签不存在' });
  scheduleAssetBackup('tag-delete');
  res.json({ ok: true });
});

app.post('/api/tags/:id/merge', (req, res) => {
  const id = parseId(req.params.id);
  const targetId = parseId(req.body?.targetId);
  if (!id || !targetId) return badRequest(res, '无效的标签 ID');
  const result = tagsApi.mergeTags(id, targetId);
  scheduleAssetBackup('tag-merge');
  res.json({ ...result, tags: tagsApi.listTags() });
});

app.post('/api/albums/:id/tags', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '无效的专辑 ID');
  if (!store.getAlbumById(id)) return res.status(404).json({ error: '专辑不存在' });
  const result = tagsApi.applyAlbumTags([id], {
    add: req.body?.add ?? [], remove: req.body?.remove ?? [],
  });
  scheduleAssetBackup('album-tags');
  res.json({ ...result, tags: tagsApi.getAlbumTags(id), allTags: tagsApi.listTags() });
});

app.post('/api/albums/tags/bulk', (req, res) => {
  const ids = (req.body?.ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return badRequest(res, '未选择专辑');
  const result = tagsApi.applyAlbumTags(ids, {
    add: req.body?.add ?? [], remove: req.body?.remove ?? [],
  });
  scheduleAssetBackup('album-tags-bulk');
  res.json({ ...result, albums: ids.length });
});

/* ------------------------------------------------------------- completeness */

app.get('/api/incomplete', (req, res) => {
  const group = req.query.group ? String(req.query.group) : null;
  const status = ['critical', 'advisory'].includes(String(req.query.status)) ? String(req.query.status) : null;
  const limit = Math.min(Number(req.query.limit) || 300, 2000);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  res.json({
    summary: completeness.incompleteSummary(),
    ...completeness.listIncomplete({ group, status, limit, offset }),
  });
});

/* ----------------------------------------------------------- covers & audio */

app.get('/api/cover/:hash', asyncRoute(async (req, res) => {
  const hash = path.basename(String(req.params.hash));
  const row = store.getCoverByHash(hash);
  if (!row) return res.status(404).end();

  const file = path.join(COVER_DIR, path.basename(row.file ?? ''));
  const wantThumb = Number(req.query.w) > 0;
  const thumb = path.join(THUMB_DIR, `${hash}-${Number(req.query.w)}.img`);

  let target = file;
  if (wantThumb && fs.existsSync(thumb)) target = thumb;
  if (!fs.existsSync(target)) {
    // 数据库有引用但文件已丢失：不返回半个响应，交给扫描时的自愈逻辑重建
    if (target !== file && fs.existsSync(file)) target = file;
    else return res.status(404).json({ error: '封面文件已丢失，重新扫描即可恢复' });
  }

  res.setHeader('Content-Type', row.mime || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  const stream = fs.createReadStream(target);
  stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.end(); });
  stream.pipe(res);
}));

app.get('/api/stream/:id', asyncRoute(async (req, res) => {
  const track = store.getTrack(req.params.id);
  if (!track) return res.status(404).json({ error: '曲目不存在' });

  let stat;
  try {
    stat = await fsp.stat(track.path);
  } catch {
    return res.status(410).json({ error: '文件已被移动或删除' });
  }

  // 视频轨要用 video/* 才能被浏览器的 <video> 播放
  const ext = track.ext?.toLowerCase();
  const videoMime = track.file_kind === 'video' ? VIDEO_MIME[ext] : null;
  const mime = videoMime ?? MIME_BY_EXT[ext] ?? 'application/octet-stream';
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  if (req.query.download) {
    res.setHeader('Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(track.filename ?? 'audio')}`);
  }

  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Length', stat.size);
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(track.path).pipe(res);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) {
    res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
    return res.end();
  }
  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);
  if (start === null && end === null) {
    res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
    return res.end();
  }
  if (start === null) {
    start = Math.max(stat.size - end, 0);
    end = stat.size - 1;
  } else if (end === null || end >= stat.size) {
    end = stat.size - 1;
  }
  if (start > end || start >= stat.size) {
    res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
    return res.end();
  }

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(track.path, { start, end }).pipe(res);
}));

/* ------------------------------------------------------------------- backup */

app.get('/api/backup/export', (req, res) => {
  const payload = assets.exportUserAssets();
  if (req.query.download) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="album-manager-assets-${new Date().toISOString().slice(0, 10)}.json"`);
  }
  res.json(payload);
});

app.post('/api/backup/import', (req, res) => {
  try {
    const result = assets.importUserAssets(req.body);
    res.json({ ok: true, result });
  } catch (err) {
    badRequest(res, err.message);
  }
});

app.get('/api/backup/list', (req, res) => {
  res.json({ backups: assets.listAutoBackups(), lastBackupAt: assets.lastBackupAt() });
});

app.post('/api/backup/snapshot', (req, res) => {
  const file = assets.writeAutoBackup('manual');
  res.json({ ok: Boolean(file), file, backups: assets.listAutoBackups() });
});

/* ------------------------------------------------------------ 写任务 V2.2 */

const planArgs = (req, id) => ({
  albumId: id,
  trackId: req.body?.trackId ? Number(req.body.trackId) : null,
  fields: req.body?.fields ?? {},
  clear: req.body?.clear ?? [],
  scope: req.body?.scope === 'track' ? 'track' : 'album',
  trackOverrides: req.body?.trackOverrides ?? {},
  trackClears: req.body?.trackClears ?? {},
});

app.post('/api/albums/:id/metadata/preview', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '无效的专辑 ID');
  if (!store.getAlbumById(id)) return res.status(404).json({ error: '专辑不存在' });

  const plan = writeJobs.planMetadataEdit(planArgs(req, id));
  if (!plan.ok) return badRequest(res, plan.errors.join('；'));
  res.json({
    preview: {
      summary: plan.summary,
      changes: plan.changes,
      backupLocation: '音乐库根目录下的 .lam-undo/<任务号>/（与源文件同卷，撤销零拷贝）',
    },
  });
});

app.post('/api/albums/:id/metadata', asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return badRequest(res, '无效的专辑 ID');
  if (!store.getAlbumById(id)) return res.status(404).json({ error: '专辑不存在' });
  if (isScanning()) return res.status(409).json({ error: '扫描进行中，请稍后再试' });
  if (writeJobs.isWriting()) return res.status(409).json({ error: '已有写任务在进行中' });

  const plan = writeJobs.planMetadataEdit(planArgs(req, id));
  if (!plan.ok) return badRequest(res, plan.errors.join('；'));

  const jobId = writeJobs.createJob({
    type: 'metadata',
    items: plan.items,
    payload: { patches: plan.patches, snapshots: plan.snapshots, albumId: id },
  });
  // 异步执行，前端轮询任务进度
  writeJobs.runJob(jobId).catch((err) => console.error('[write job]', err.message));
  res.status(202).json({ jobId, summary: plan.summary });
}));

app.get('/api/jobs', (req, res) => {
  res.json({ jobs: writeJobs.listJobs({ limit: Number(req.query.limit) || 20 }) });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = writeJobs.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '写任务不存在' });
  res.json({ job, writing: writeJobs.isWriting() });
});

app.post('/api/jobs/:id/undo', asyncRoute(async (req, res) => {
  try {
    const result = await writeJobs.undoJob(req.params.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    badRequest(res, err.message);
  }
}));

app.get('/api/writer/support', (req, res) => {
  res.json({ support: writers.describeWriteSupport() });
});

/* ------------------------------------------------------- 封面管理 V2.2 */

const MAX_COVER_BYTES = 10 * 1024 * 1024;
const FOLDER_COVER_NAMES = ['cover.jpg', 'folder.jpg', 'front.jpg'];

function coverUrlFor(album) {
  return album?.cover_hash ? `/api/cover/${album.cover_hash}` : null;
}

/** 列出可选封面来源：专辑目录里的图片 + 各曲目的内嵌图片数量 */
app.get('/api/albums/:id/cover/candidates', asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const album = store.getAlbumById(id);
  if (!album) return res.status(404).json({ error: '专辑不存在' });

  const tracks = store.listAlbumTracks(id);
  const dir = tracks[0] ? path.dirname(tracks[0].path) : null;
  const folderImages = [];
  if (dir) {
    try {
      for (const name of await fsp.readdir(dir)) {
        if (/\.(jpe?g|png|webp|gif|bmp)$/i.test(name)) folderImages.push({ name, path: path.join(dir, name) });
      }
    } catch { /* 目录不可读则忽略 */ }
  }
  res.json({
    current: { cover_url: coverUrlFor(album), cover_source: album.cover_source },
    folderImages,
    embeddedCount: tracks.filter((t) => t.has_cover).length,
    trackCount: tracks.length,
    folderCoverExists: folderImages.some((f) => FOLDER_COVER_NAMES.includes(f.name.toLowerCase())),
  });
}));

/** 设置封面：embedded 写入每首曲目内嵌图；folder 写目录 cover.jpg；db 仅存库 */
app.post('/api/albums/:id/cover', asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const album = store.getAlbumById(id);
  if (!album) return res.status(404).json({ error: '专辑不存在' });
  if (isScanning()) return res.status(409).json({ error: '扫描进行中，请稍后再试' });
  if (writeJobs.isWriting()) return res.status(409).json({ error: '已有写任务在进行中' });

  const mode = ['embedded', 'folder', 'db'].includes(req.body?.mode) ? req.body.mode : 'embedded';

  let buffer = null;
  if (req.body?.imageBase64) {
    buffer = Buffer.from(String(req.body.imageBase64).replace(/^data:[^;]+;base64,/, ''), 'base64');
  } else if (req.body?.sourcePath) {
    const src = path.resolve(String(req.body.sourcePath));
    try { buffer = await fsp.readFile(src); } catch { return badRequest(res, '图片路径不可读'); }
  }
  if (!buffer?.length) return badRequest(res, '缺少图片内容');
  if (buffer.length > MAX_COVER_BYTES) {
    return badRequest(res, `图片超过 ${MAX_COVER_BYTES / 1048576} MB，请先压缩`);
  }

  const mime = maintenance.detectImageMime(buffer);
  if (!mime) return badRequest(res, '不是可识别的图片（支持 JPEG / PNG / WebP / GIF / BMP）');

  const stored = maintenance.persistCoverImage(buffer, mime, 'manual');
  store.setManualCover(id, stored);
  scheduleAssetBackup('cover-set');

  const tracks = store.listAlbumTracks(id);
  if (!tracks.length) return badRequest(res, '该专辑没有曲目');

  if (mode === 'db') {
    return res.json({ ok: true, mode, cover_url: coverUrlFor(store.getAlbumById(id)) });
  }

  if (mode === 'embedded') {
    const patches = {};
    const snapshots = {};
    for (const t of tracks) {
      patches[String(t.id)] = { picture: { useJobPicture: true } };
      snapshots[String(t.id)] = { size: t.size, mtime: t.mtime };
    }
    const jobId = writeJobs.createJob({
      type: 'cover-embedded',
      items: tracks.map((t) => ({ trackId: t.id, path: t.path })),
      payload: {
        patches,
        snapshots,
        picture: { dataBase64: buffer.toString('base64'), mimeType: mime, description: 'front' },
      },
    });
    writeJobs.runJob(jobId).catch((err) => console.error('[cover job]', err.message));
    return res.status(202).json({ jobId, mode, files: tracks.length });
  }

  // folder：写目录 cover.jpg（同卷备份，可撤销）
  const dir = path.dirname(tracks[0].path);
  const target = path.join(dir, 'cover.jpg');
  const lib = tracks[0].library_id ? store.getLibrary(tracks[0].library_id) : null;
  const jobId = writeJobs.createJob({
    type: 'cover-folder',
    items: [{ trackId: null, path: target }],
    payload: {
      operations: {
        0: {
          dataBase64: buffer.toString('base64'),
          backupRoot: lib?.path ? path.join(lib.path, '.lam-undo') : undefined,
        },
      },
    },
  });
  writeJobs.runJob(jobId).catch((err) => console.error('[cover job]', err.message));
  return res.status(202).json({ jobId, mode, target });
}));

/** 移除封面：embedded 清空内嵌图；folder 删除 cover.jpg（需显式确认）；db 仅清库内引用 */
app.delete('/api/albums/:id/cover', asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const album = store.getAlbumById(id);
  if (!album) return res.status(404).json({ error: '专辑不存在' });
  if (isScanning()) return res.status(409).json({ error: '扫描进行中，请稍后再试' });
  if (writeJobs.isWriting()) return res.status(409).json({ error: '已有写任务在进行中' });

  const mode = ['embedded', 'folder', 'db'].includes(req.body?.mode) ? req.body.mode : 'db';
  const tracks = store.listAlbumTracks(id);
  store.clearCover(id);
  scheduleAssetBackup('cover-remove');

  if (mode === 'db' || !tracks.length) {
    return res.json({ ok: true, mode: 'db', cleared: true });
  }

  if (mode === 'embedded') {
    const patches = {};
    const snapshots = {};
    for (const t of tracks) {
      patches[String(t.id)] = { picture: null };
      snapshots[String(t.id)] = { size: t.size, mtime: t.mtime };
    }
    const jobId = writeJobs.createJob({
      type: 'cover-embedded',
      items: tracks.map((t) => ({ trackId: t.id, path: t.path })),
      payload: { patches, snapshots },
    });
    writeJobs.runJob(jobId).catch((err) => console.error('[cover job]', err.message));
    return res.status(202).json({ jobId, mode, files: tracks.length });
  }

  // folder：删除目录里的 cover.jpg（改名进备份目录，可撤销）
  const dir = path.dirname(tracks[0].path);
  const names = [];
  for (const name of FOLDER_COVER_NAMES) {
    if (fs.existsSync(path.join(dir, name))) names.push(name);
  }
  if (!names.length) return res.json({ ok: true, mode: 'folder', deleted: 0 });
  const lib = tracks[0].library_id ? store.getLibrary(tracks[0].library_id) : null;
  const jobId = writeJobs.createJob({
    type: 'cover-folder',
    items: names.map((name) => ({ trackId: null, path: path.join(dir, name) })),
    payload: {
      operations: Object.fromEntries(names.map((name, i) => [String(i), {
        kind: 'delete-file',
        backupRoot: lib?.path ? path.join(lib.path, '.lam-undo') : undefined,
      }])),
    },
  });
  writeJobs.runJob(jobId).catch((err) => console.error('[cover job]', err.message));
  return res.status(202).json({ jobId, mode, deleted: names.length });
}));

/* ------------------------------------------------------------ maintenance */

app.get('/api/maintenance/usage', (req, res) => {
  res.json({ covers: maintenance.coverStorageUsage(), referenced: store.referencedCoverFiles().size });
});

app.post('/api/maintenance/gc-covers', (req, res) => {
  const dryRun = Boolean(req.body?.dryRun);
  res.json({ result: maintenance.collectOrphanCovers({ dryRun }) });
});

app.post('/api/maintenance/prune-missing', (req, res) => {
  const tracks = maintenance.pruneMissingTracks();
  const albums = maintenance.pruneEmptyAlbums();
  res.json({ tracks, albums });
});

/* ------------------------------------------------------------------ settings */

app.get('/api/config', (req, res) => res.json({ config: readConfig() }));

app.post('/api/config', (req, res) => {
  const patch = {};
  if (req.body?.port != null) patch.port = Number(req.body.port);
  if (req.body?.host != null) patch.host = String(req.body.host);
  if (req.body?.coverSize != null) patch.coverSize = String(req.body.coverSize);
  if (req.body?.playMode != null) patch.playMode = String(req.body.playMode);
  res.json({ config: writeConfig(patch) });
});

/* -------------------------------------------------------------- spa fallback */

app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[api error]', err);
  if (res.headersSent) return;
  res.status(500).json({ error: String(err?.message ?? err) });
});

const port = Number(process.env.PORT || config.port || 8787);
const host = process.env.HOST || config.host || '127.0.0.1';

const server = app.listen(port, host, () => {
  console.log(`Luna v3.0 已启动： http://${host}:${port}`);
  console.log(`数据目录： ${DATA_DIR}`);
  if (store.migrationReport.migrated) {
    console.log(`已从 V${store.migrationReport.from} 迁移到 V${store.SCHEMA_VERSION}，`
      + `生成 ${store.migrationReport.albums} 张专辑实体`
      + (store.migrationReport.backup ? `，旧库备份：${store.migrationReport.backup}` : ''));
  }
  // 处理上次进程中断留下的写任务痕迹
  const stale = writeJobs.markInterruptedJobs();
  if (stale.length) {
    console.log(`发现 ${stale.length} 个中断的写任务，正在检查并恢复…`);
    writeJobs.recoverInterruptedWrites()
      .then((report) => {
        console.log(`中断恢复完成：还原 ${report.restored} 个文件，清理 ${report.cleaned} 个临时文件`);
      })
      .catch((err) => console.error('[recover]', err.message));
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n正在关闭…');
    server.close(() => {
      store.closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
