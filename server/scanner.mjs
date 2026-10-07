import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { parseFile } from 'music-metadata';

import {
  AUDIO_EXTENSIONS, COVER_DIR, UNDO_DIR_NAME, albumKeyOf, normalizeText,
} from './config.mjs';
import * as store from './db.mjs';
import * as tagsApi from './tags.mjs';
import { collectOrphanCovers, albumsWithMissingCoverFiles, detectImageMime, pruneEmptyAlbums } from './maintenance.mjs';
import { isWriting, cleanupTempFiles } from './write-jobs.mjs';
import { analyzeRelease, locateRelease, VIDEO_EXT } from './asmr.mjs';

/** 扫描时一并收集视频（仅音声发行会用到它们） */
const SCAN_EXTENSIONS = new Set([...AUDIO_EXTENSIONS, ...VIDEO_EXT]);

/** 音声发行自动打上的标签名 */
const ASMR_TAG_NAME = 'ASMR';

const SKIP_DIRS = new Set([
  'system volume information', '$recycle.bin', 'node_modules', '.git', '.svn',
  '__macosx', 'recycler', 'windows', '$windows.~ws', '$windows.~bt',
  UNDO_DIR_NAME.toLowerCase(),
]);

const COVER_FILE_CANDIDATES = [
  'cover.jpg', 'folder.jpg', 'front.jpg', 'album.jpg', 'albumart.jpg',
  'cover.jpeg', 'folder.jpeg', 'cover.png', 'folder.png', 'front.png',
  'cover.webp', 'folder.webp',
];

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
};

/* ------------------------------------------------------------ scan job state */

export const scanState = {
  running: false,
  cancelRequested: false,
  startedAt: null,
  finishedAt: null,
  phase: 'idle',
  currentLibrary: null,
  libraryIndex: 0,
  libraryTotal: 0,
  filesFound: 0,
  processed: 0,
  added: 0,
  updated: 0,
  skipped: 0,
  failed: 0,
  coverExtracted: 0,
  coversReclaimed: 0,
  coverBytesReclaimed: 0,
  brokenCovers: 0,
  removed: 0,
  albumsCreated: 0,
  albumsMerged: 0,
  errors: [],
};

function resetState() {
  Object.assign(scanState, {
    running: true,
    cancelRequested: false,
    startedAt: Date.now(),
    finishedAt: null,
    phase: '准备中',
    currentLibrary: null,
    libraryIndex: 0,
    libraryTotal: 0,
    filesFound: 0,
    processed: 0,
    added: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    coverExtracted: 0,
    coversReclaimed: 0,
    coverBytesReclaimed: 0,
    brokenCovers: 0,
    removed: 0,
    albumsCreated: 0,
    albumsMerged: 0,
    errors: [],
  });
}

function pushError(message) {
  scanState.failed += 1;
  if (scanState.errors.length < 30) scanState.errors.push(message);
}

/** 把最后一次扫描结果落库（修复 D3：服务重启后仍可查看） */
function persistLastScan() {
  try {
    store.setMeta('last_scan', JSON.stringify({
      finishedAt: scanState.finishedAt,
      startedAt: scanState.startedAt,
      phase: scanState.phase,
      filesFound: scanState.filesFound,
      processed: scanState.processed,
      added: scanState.added,
      updated: scanState.updated,
      skipped: scanState.skipped,
      removed: scanState.removed,
      failed: scanState.failed,
      coverExtracted: scanState.coverExtracted,
      coversReclaimed: scanState.coversReclaimed,
      coverBytesReclaimed: scanState.coverBytesReclaimed,
      errors: scanState.errors.slice(0, 30),
    }));
  } catch {
    /* 落库失败不影响扫描结果 */
  }
}

export function lastScanReport() {
  try {
    const raw = store.getMeta('last_scan');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- walking */

async function walkAudioFiles(root) {
  const found = [];
  const stack = [root];
  while (stack.length) {
    if (scanState.cancelRequested) break;
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      pushError(`无法读取目录：${dir}（${err.code ?? err.message}）`);
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (SKIP_DIRS.has(lower) || entry.name.startsWith('.')) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        if (entry.name.startsWith('.')) continue;
        if (entry.name.startsWith('.lam-tmp-')) continue; // 写任务残留（V2.2 使用）
        const ext = path.extname(entry.name).toLowerCase();
        if (!SCAN_EXTENSIONS.has(ext)) continue;
        found.push(full);
      }
    }
  }
  return found;
}

/* ------------------------------------------------------ 音声发行（三层模型） */

/** 名称宽松归一（全角转半角、去空白、小写） */
function relaxName(s) {
  return String(s ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * 决定音声发行采用哪个艺术家。
 *
 * 规则（按用户要求）：
 *   1. **以曲目 artist 标签为准**（音声作品里它最贴近实际演出者）
 *   2. albumartist 标签与之明显不同时，不改用，只作为「建议」返回，界面上提示用户选择
 *   3. 若已有历史决定（adopted / kept），不再重复提示
 */
function decideArtist(analysis, previousDecision = null) {
  const trackArtist = String(analysis.artistFromTag ?? '').trim() || null;
  const albumArtistTag = String(analysis.albumArtistFromTag ?? '').trim() || null;

  // 二者一致（或互相包含）→ 没有分歧，直接用曲目艺术家
  if (!albumArtistTag || !trackArtist) {
    return { adopt: trackArtist ?? albumArtistTag, suggest: null };
  }
  const a = relaxName(trackArtist);
  const b = relaxName(albumArtistTag);
  const same = a === b || a.includes(b) || b.includes(a);
  if (same) return { adopt: trackArtist, suggest: null };

  // 有分歧：以 artist 为准；albumartist 作为建议
  return {
    adopt: trackArtist,
    suggest: previousDecision ? null : albumArtistTag,
  };
}

/**
 * 只重新解析一个音声发行（人工合并结论生效 / 手动刷新用），不触碰其它专辑。
 */
export async function rescanReleaseRoot({ releaseRoot, libraryId }) {
  if (isWriting()) throw new Error('正在写回文件，请稍后再试');
  if (!releaseRoot) throw new Error('缺少发行根路径');
  const seen = new Set();
  const result = await ingestRelease({ root: releaseRoot, libraryId, seen });
  let removed = 0;
  for (const p of store.trackPathsUnder(releaseRoot)) {
    if (!seen.has(p)) { store.deleteTrackByPath(p); removed += 1; }
  }
  return { ...result, removed };
}

/**
 * 把一个音声发行解析并写入三层模型：
 *   专辑卡片（kind=voice）→ 版本（album_versions）→ 轨道（tracks）
 *
 * 收录范围遵循 R5「仅使用优先版本」：同一版本内只收 wav（或唯一存在的格式），
 * 视频文件作为所属轨道的「视频版」单独收录，以便一键播放。
 */
async function ingestRelease({ root, libraryId, seen }) {
  const existingAlbum = store.findVoiceAlbum(root);
  const decisions = existingAlbum
    ? store.getMergeDecisions(existingAlbum.id)
    : { merge: [], separate: [] };

  const analysis = await analyzeRelease(root, { readTags: true, decisions });

  // 艺术家：以曲目 artist 标签为准；albumartist 与之冲突时只作「建议」，由用户选择
  const previousDecision = existingAlbum?.artist_decision ?? null;
  const { adopt: artistToAdopt, suggest: artistSuggestedOnly } = decideArtist(analysis, previousDecision);

  const albumId = store.upsertVoiceAlbum({
    releaseRoot: root,
    rjCode: analysis.rjCode,
    title: analysis.titleFromTag ?? analysis.titleFromFolder,
    titleSource: analysis.titleFromTag ? 'tag' : 'folder',
    artist: artistToAdopt,
    artistSuggested: artistSuggestedOnly,
    hasBonus: analysis.hasBonus,
    hasVideo: [...analysis.tracks, ...analysis.bonusTracks].some((t) => t.hasVideo),
  });

  // 版本
  const versionIds = new Map();
  const preferredByKey = new Map();
  for (const v of analysis.versions) {
    const id = store.upsertAlbumVersion(albumId, {
      name: v.name,
      nameKey: v.key,
      groupKind: v.group,
      preferredFormat: v.preferredFormat,
      dirPath: null,
      fileCount: v.fileCount,
      totalBytes: v.bytes,
    });
    versionIds.set(v.key, id);
    preferredByKey.set(v.key, v.preferredFormat);
  }
  store.pruneAlbumVersions(albumId, [...versionIds.values()]);

  // 轨道
  let trackCount = 0;
  for (const row of [...analysis.tracks, ...analysis.bonusTracks]) {
    for (const entry of row.versions) {
      const isVideo = entry.file.kind === 'video';
      const preferred = preferredByKey.get(entry.versionKey);
      const format = entry.file.ext.replace('.', '');
      // 视频版一律收录；音频只收该版本的优先格式
      if (!isVideo && format !== preferred) continue;

      const filePath = entry.file.path;
      seen.add(filePath);
      let fstat;
      try {
        fstat = await fsp.stat(filePath);
      } catch {
        continue;   // 文件在解析与写入之间消失
      }
      const tagged = isVideo ? {} : await readTags(filePath);

      // 音声标题以解析结果为准（标签回退出来的「文件名标题」带有序号前缀，不用）
      const title = (!isVideo && tagged.titleSource === 'tag' && tagged.title)
        ? tagged.title
        : row.title;

      store.upsertTrack({
        path: filePath,
        dir: path.dirname(filePath),
        libraryId,
        filename: entry.file.name,
        ext: entry.file.ext,
        size: fstat.size,
        mtime: Math.round(fstat.mtimeMs),
        title,
        artist: tagged.artist ?? null,
        albumArtist: tagged.albumArtist ?? analysis.artistFromTag ?? null,
        album: analysis.titleFromTag ?? analysis.titleFromFolder,
        albumKey: store.voiceAlbumKey(root),
        albumId,
        trackNo: row.trackNo ?? null,
        discNo: null,
        year: tagged.year ?? null,
        genre: tagged.genre ?? null,
        composer: null,
        duration: tagged.duration ?? null,
        bitrate: tagged.bitrate ?? null,
        sampleRate: tagged.sampleRate ?? null,
        channels: tagged.channels ?? null,
        codec: tagged.codec ?? (isVideo ? 'video' : null),
        container: tagged.container ?? null,
        titleSource: (!isVideo && tagged.titleSource === 'tag' && tagged.title) ? 'tag' : 'filename',
        hasCover: false,
        parseError: null,
        versionId: versionIds.get(entry.versionKey) ?? null,
        trackKey: row.key,
        fileKind: isVideo ? 'video' : 'audio',
        isBonus: row.isBonus,
        variantLabel: entry.variantLabel ?? null,
      });
      trackCount += 1;
    }
  }

  // 封面（R13）：只在尚未手工设置过封面时套用
  if (analysis.cover && !existingAlbum?.cover_file) {
    try {
      const buf = await fsp.readFile(analysis.cover.path);
      const cover = await persistCoverImage(buf, detectImageMime(buf), 'manual');
      store.applyCover(albumId, cover);
    } catch { /* 封面失败不影响曲目入库 */ }
  }

  scanState.albumsCreated += existingAlbum ? 0 : 1;
  scanState.added += trackCount;

  // 音声发行自动打上「ASMR」标签，便于在专辑墙按类别检索
  try {
    const asmrTag = tagsApi.ensureTag(ASMR_TAG_NAME);
    if (asmrTag?.id) tagsApi.applyAlbumTags([albumId], { add: [asmrTag.id], remove: [] });
  } catch (err) {
    pushError(`自动添加 ASMR 标签失败：${err.message}`);
  }

  return { albumId, versions: analysis.versions.length, tracks: trackCount };
}

/* -------------------------------------------------------------------- covers */

function pickFrontPicture(pictures) {
  if (!pictures?.length) return null;
  const front = pictures.find((p) => String(p.type ?? '').toLowerCase().includes('front'));
  return front ?? pictures[0];
}

async function persistCoverImage(buffer, mime, source) {
  const hash = crypto.createHash('sha1').update(buffer).digest('hex');
  const ext = MIME_EXT[mime] ?? '.jpg';
  const file = `${hash}${ext}`;
  const target = path.join(COVER_DIR, file);
  try {
    await fsp.access(target);
  } catch {
    await fsp.writeFile(target, buffer);
  }
  return { hash, file, mime, source };
}

async function coverFromDirectory(dir) {
  if (!dir) return null;
  for (const name of COVER_FILE_CANDIDATES) {
    const candidate = path.join(dir, name);
    try {
      const stat = await fsp.stat(candidate);
      if (!stat.isFile()) continue;
      const buffer = await fsp.readFile(candidate);
      const ext = path.extname(name).toLowerCase();
      const mime = ext === '.png' ? 'image/png'
        : ext === '.webp' ? 'image/webp'
          : ext === '.gif' ? 'image/gif' : 'image/jpeg';
      return await persistCoverImage(buffer, mime, 'folder');
    } catch {
      /* 尝试下一个候选文件名 */
    }
  }
  return null;
}

/* ------------------------------------------------------------------- parsing */

function firstString(value) {
  if (Array.isArray(value)) return normalizeText(value.find((v) => normalizeText(v)) ?? '');
  return normalizeText(value);
}

async function readTags(file) {
  const ext = path.extname(file).toLowerCase();
  const base = { dir: path.dirname(file), filename: path.basename(file), ext };
  try {
    const { common, format } = await parseFile(file, { duration: true, skipCovers: false });
    const taggedTitle = normalizeText(common.title);
    const title = taggedTitle || path.basename(file, ext);
    const artist = firstString(common.artist) || normalizeText(common.artists?.[0]);
    const albumArtist = firstString(common.albumartist) || artist;
    const album = normalizeText(common.album);
    const year = Number.isFinite(common.year)
      ? common.year
      : (Number.parseInt(String(common.date ?? '').slice(0, 4), 10) || null);
    return {
      ...base,
      title,
      titleSource: taggedTitle ? 'tag' : 'filename',
      artist: artist || null,
      albumArtist: albumArtist || null,
      album: album || null,
      albumKey: albumKeyOf({ album, albumArtist, artist, dir: base.dir }),
      trackNo: Number.isFinite(common.track?.no) ? common.track.no : null,
      discNo: Number.isFinite(common.disk?.no) ? common.disk.no : null,
      year: year || null,
      genre: firstString(common.genre) || null,
      composer: firstString(common.composer) || null,
      duration: Number.isFinite(format.duration) ? format.duration : null,
      bitrate: Number.isFinite(format.bitrate) ? Math.round(format.bitrate) : null,
      sampleRate: Number.isFinite(format.sampleRate) ? format.sampleRate : null,
      channels: Number.isFinite(format.numberOfChannels) ? format.numberOfChannels : null,
      codec: normalizeText(format.codec) || null,
      container: normalizeText(format.container) || null,
      picture: pickFrontPicture(common.picture),
      parseError: null,
    };
  } catch (err) {
    return {
      ...base,
      title: path.basename(file, ext),
      titleSource: 'filename',
      artist: null,
      albumArtist: null,
      album: null,
      albumKey: albumKeyOf({ dir: base.dir }),
      trackNo: null,
      discNo: null,
      year: null,
      genre: null,
      composer: null,
      duration: null,
      bitrate: null,
      sampleRate: null,
      channels: null,
      codec: null,
      container: null,
      picture: null,
      parseError: `${err.code ?? err.name ?? 'Error'}: ${String(err.message ?? err).slice(0, 160)}`,
    };
  }
}

/* --------------------------------------------------------------- scan driver */

let runningPromise = null;

export function isScanning() {
  return scanState.running;
}

export function startScan({ libraryIds = null } = {}) {
  if (scanState.running) return { started: false, reason: 'already-running', state: scanState };
  if (isWriting()) return { started: false, reason: 'writing', state: scanState };
  runningPromise = runScan({ libraryIds }).finally(() => {
    scanState.running = false;
    scanState.finishedAt = Date.now();
    scanState.phase = scanState.cancelRequested ? '已取消' : '完成';
    scanState.currentLibrary = null;
    persistLastScan();
    runningPromise = null;
  });
  return { started: true, state: scanState };
}

export function cancelScan() {
  if (!scanState.running) return false;
  scanState.cancelRequested = true;
  scanState.phase = '正在取消…';
  return true;
}

export async function waitForScan() {
  if (runningPromise) await runningPromise;
}

async function runScan({ libraryIds }) {
  resetState();

  let libraries = store.listLibraries();
  if (Array.isArray(libraryIds) && libraryIds.length) {
    const wanted = new Set(libraryIds.map(Number));
    libraries = libraries.filter((l) => wanted.has(l.id));
  }
  scanState.libraryTotal = libraries.length;

  for (const [index, lib] of libraries.entries()) {
    if (scanState.cancelRequested) break;
    scanState.libraryIndex = index + 1;
    scanState.currentLibrary = lib.path;
    scanState.phase = '扫描文件';

    let stat;
    try {
      stat = await fsp.stat(lib.path);
    } catch (err) {
      pushError(`音乐库不存在或不可访问：${lib.path}（${err.code ?? err.message}）`);
      continue;
    }
    if (!stat.isDirectory()) {
      pushError(`音乐库路径不是目录：${lib.path}`);
      continue;
    }

    // 清理上次写任务遗留的临时文件，避免被当成音频收录
    try {
      const cleaned = await cleanupTempFiles(lib.path);
      if (cleaned) scanState.tempsCleaned = (scanState.tempsCleaned ?? 0) + cleaned;
    } catch { /* 清理失败不阻塞扫描 */ }

    const allFiles = await walkAudioFiles(lib.path);
    scanState.filesFound += allFiles.length;
    scanState.phase = '解析标签';

    // 分流：带 RJ 号的走音声三层模型，其余走普通音乐专辑模型
    const voiceGroups = new Map();
    const musicFiles = [];
    for (const file of allFiles) {
      const located = locateRelease(file);
      if (!located) {
        // 视频文件只属于音声发行，孤立视频不收录
        if (!AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
        musicFiles.push(file);
        continue;
      }
      if (!voiceGroups.has(located.releaseRoot)) voiceGroups.set(located.releaseRoot, []);
      voiceGroups.get(located.releaseRoot).push(file);
    }

    const seen = new Set();

    if (voiceGroups.size) {
      scanState.phase = '解析音声发行';
      for (const [root, group] of voiceGroups) {
        if (scanState.cancelRequested) break;
        scanState.currentRelease = path.basename(root);
        try {
          const r = await ingestRelease({ root, libraryId: lib.id, seen });
          scanState.releasesIngested = (scanState.releasesIngested ?? 0) + 1;
          scanState.releaseTracks = (scanState.releaseTracks ?? 0) + r.tracks;
        } catch (err) {
          pushError(`音声发行解析失败：${root}（${err.message}）`);
          // 失败时保守处理：这些文件不进入 seen，交由清理阶段决定，避免误删
          for (const f of group) seen.add(f);
        }
        scanState.processed += group.length;
      }
      scanState.phase = '解析标签';
    }

    let cursor = 0;

    const worker = async () => {
      while (!scanState.cancelRequested) {
        const i = cursor;
        cursor += 1;
        if (i >= musicFiles.length) return;
        const file = musicFiles[i];
        try {
          const fstat = await fsp.stat(file);
          const existing = store.findTrackByPath(file);
          if (existing && existing.size === fstat.size && existing.mtime === Math.round(fstat.mtimeMs)) {
            seen.add(file);
            scanState.skipped += 1;
            continue;
          }

          const tags = await readTags(file);

          // 专辑实体化：决定归属（可能新建 / 改名延续 / 合并）
          const resolved = store.resolveAlbumForTrack({
            id: existing?.id,
            album: tags.album,
            albumArtist: tags.albumArtist,
            artist: tags.artist,
            dir: tags.dir,
            year: tags.year,
            genre: tags.genre,
          });
          if (resolved.action === 'created') scanState.albumsCreated += 1;
          if (resolved.action === 'merged') scanState.albumsMerged += 1;

          store.upsertTrack({
            path: file,
            dir: tags.dir,
            libraryId: lib.id,
            filename: tags.filename,
            ext: tags.ext,
            size: fstat.size,
            mtime: Math.round(fstat.mtimeMs),
            title: tags.title,
            artist: tags.artist,
            albumArtist: tags.albumArtist,
            album: tags.album,
            albumKey: resolved.albumKey,
            albumId: resolved.albumId,
            trackNo: tags.trackNo,
            discNo: tags.discNo,
            year: tags.year,
            genre: tags.genre,
            composer: tags.composer,
            duration: tags.duration,
            bitrate: tags.bitrate,
            sampleRate: tags.sampleRate,
            channels: tags.channels,
            codec: tags.codec,
            container: tags.container,
            titleSource: tags.titleSource,
            hasCover: false,
            parseError: tags.parseError,
            addedAt: existing ? undefined : Date.now(),
          });

          if (tags.picture?.data) {
            const mime = normalizeText(tags.picture.format) || 'image/jpeg';
            const cover = await persistCoverImage(Buffer.from(tags.picture.data), mime, 'embedded');
            if (store.applyCover(resolved.albumId, cover)) scanState.coverExtracted += 1;
          }

          seen.add(file);
          if (existing) scanState.updated += 1;
          else scanState.added += 1;
          if (tags.parseError) pushError(`标签解析失败：${file}（${tags.parseError}）`);
        } catch (err) {
          pushError(`处理失败：${file}（${err.code ?? err.message}）`);
        } finally {
          scanState.processed += 1;
        }
      }
    };

    const concurrency = 4;
    await Promise.all(Array.from({ length: concurrency }, worker));

    if (!scanState.cancelRequested) {
      scanState.phase = '清理失效条目';
      const known = new Set(store.trackPathsInLibrary(lib.id));
      for (const p of known) {
        if (!seen.has(p)) {
          store.deleteTrackByPath(p);
          scanState.removed += 1;
        }
      }
      store.touchLibrary(lib.id);
    }
  }

  if (!scanState.cancelRequested) {
    // 1) 校验封面文件是否存在，丢失的清空引用以便重新提取（自愈）
    scanState.phase = '校验封面文件';
    try {
      const rows = store.albumsWithCoverFiles();
      const broken = albumsWithMissingCoverFiles(rows);
      for (const id of broken) store.clearCover(id);
      scanState.brokenCovers = broken.length;
    } catch (err) {
      pushError(`封面校验失败：${err.message}`);
    }

    // 2) 目录里找 cover.jpg / folder.jpg
    await backfillFolderCovers();

    // 3) 仍无封面的专辑，从一首曲目的内嵌图片恢复（增量扫描不会重解析未变化文件）
    await recoverEmbeddedCovers();

    scanState.phase = '同步封面标记';
    store.syncCoverFlags();

    // 4) 回收孤儿封面文件
    scanState.phase = '回收无用封面';
    try {
      const gc = collectOrphanCovers();
      scanState.coversReclaimed = gc.files;
      scanState.coverBytesReclaimed = gc.bytes;
    } catch (err) {
      pushError(`封面回收失败：${err.message}`);
    }

    // 5) 清理因轨道改属而变空的专辑卡片（音声三层模型重塑归属后会留下空卡）
    scanState.phase = '清理空专辑';
    try {
      const pruned = pruneEmptyAlbums();
      scanState.albumsPruned = pruned.removed;
    } catch (err) {
      pushError(`空专辑清理失败：${err.message}`);
    }
  }
}

/** 为仍无封面的专辑，从其中一首曲目读取内嵌封面 */
async function recoverEmbeddedCovers() {
  const pending = store.albumsMissingCover();
  if (!pending.length) return;
  scanState.phase = '恢复内嵌封面';
  for (const row of pending) {
    if (scanState.cancelRequested) return;
    const track = store.firstTrackOfAlbum(row.id);
    if (!track) continue;
    try {
      const { common } = await parseFile(track.path, { duration: false, skipCovers: false });
      const picture = pickFrontPicture(common.picture);
      if (!picture?.data) continue;
      const mime = normalizeText(picture.format) || 'image/jpeg';
      const cover = await persistCoverImage(Buffer.from(picture.data), mime, 'embedded');
      if (store.applyCover(row.id, cover)) scanState.coverExtracted += 1;
    } catch {
      /* 单曲失败不影响其他专辑 */
    }
  }
}

/** 为「没有封面」的专辑再找一次同目录的 cover.jpg / folder.jpg 等 */
async function backfillFolderCovers() {
  scanState.phase = '补充封面';
  const pending = store.albumsMissingCover();
  for (const row of pending) {
    if (scanState.cancelRequested) return;
    try {
      const cover = await coverFromDirectory(row.dir);
      if (!cover) continue;
      if (store.applyCover(row.id, cover)) scanState.coverExtracted += 1;
    } catch (err) {
      pushError(`封面读取失败：${row.dir}（${err.code ?? err.message}）`);
    }
  }
}
