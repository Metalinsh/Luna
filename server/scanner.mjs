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
import { analyzeRelease, locateRelease, VIDEO_EXT, baseNameOf, extractTrackNo, displayTitleOf } from './asmr.mjs';
import {
  isArchiveName, looksLikeZip, probeZip, summarizeArchive,
  virtualPath, splitVirtualPath, isVirtualPath, readEntryData, findEntry,
} from './zip-reader.mjs';

/** 扫描时一并收集视频（仅音声发行会用到它们） */
const SCAN_EXTENSIONS = new Set([...AUDIO_EXTENSIONS, ...VIDEO_EXT]);

/** 音声发行自动打上的标签名 */
const ASMR_TAG_NAME = 'ASMR';

/** 被认定为「ASMR 音乐库」的目录名（不区分大小写） */
const ASMR_FOLDER = 'asmr';

/**
 * 判断某个路径是否位于名为 ASMR 的目录之下。
 *
 * 规则（用户指定）：**音乐库文件夹名称为 ASMR 的，其中的专辑统一视为 ASMR；
 * 不在其中的专辑均非 ASMR。** 与是否带 RJ 号、是否压缩包都无关。
 *
 * 路径段一律按 `\`、`/` 以及压缩包虚拟路径分隔符（NUL）切开，
 * 因此 E:\Music\ASMR\[RJ…]\x.mp3 与 D:\ASMR\专辑.zip␀曲.mp3 都能命中。
 */
export function isUnderAsmrFolder(p) {
  return String(p ?? '')
    .split(/[\\/\u0000]+/)
    .some((seg) => seg.toLowerCase() === ASMR_FOLDER);
}

/**
 * 自动维护「ASMR」标签。
 *
 * 非 ASMR 目录下的专辑会被**移除**该标签：否则用户把专辑移出 ASMR 目录后，
 * 旧标签会一直留着，而本功能的意义正是让标签跟随目录。
 */
function syncAsmrTag(albumId, samplePath) {
  if (!albumId) return;
  try {
    const asmrTag = tagsApi.ensureTag(ASMR_TAG_NAME);
    if (!asmrTag?.id) return;
    const shouldTag = isUnderAsmrFolder(samplePath);
    tagsApi.applyAlbumTags([albumId], {
      add: shouldTag ? [asmrTag.id] : [],
      remove: shouldTag ? [] : [asmrTag.id],
    });
  } catch (err) {
    pushError(`自动维护 ASMR 标签失败：${err.message}`);
  }
}

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
  // 压缩包（P1 只读挂载）：见 docs/压缩包支持设计.md §5.3
  archivesFound: 0,
  archivesParsed: 0,
  archivesFailed: 0,
  archivesUnsupported: 0,
  archivesEncrypted: 0,
  archivesRemoved: 0,
  archiveEntries: 0,
  archiveTracks: 0,
  archiveBytes: 0,
  archiveMs: 0,
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
    archivesFound: 0,
    archivesParsed: 0,
    archivesFailed: 0,
    archivesUnsupported: 0,
    archivesEncrypted: 0,
    archivesRemoved: 0,
    archiveEntries: 0,
    archiveTracks: 0,
    archiveBytes: 0,
    archiveMs: 0,
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
      // 压缩包统计（P1）：让「为什么多了这些专辑」在扫描报告里可解释
      archivesFound: scanState.archivesFound,
      archivesParsed: scanState.archivesParsed,
      archivesFailed: scanState.archivesFailed,
      archivesUnsupported: scanState.archivesUnsupported,
      archivesEncrypted: scanState.archivesEncrypted,
      archivesRemoved: scanState.archivesRemoved,
      archiveEntries: scanState.archiveEntries,
      archiveTracks: scanState.archiveTracks,
      archiveBytes: scanState.archiveBytes,
      archiveMs: scanState.archiveMs,
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
  const archives = [];
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
        // 压缩包单独收集：它本身不是音频，但它内部可能整包都是音频（P1 只读挂载）
        if (isArchiveName(entry.name)) { archives.push(full); continue; }
        if (!SCAN_EXTENSIONS.has(ext)) continue;
        found.push(full);
      }
    }
  }
  return { files: found, archives };
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

/** 压缩包虚拟路径下的曲目取信息：不做任何解压（P1 只读挂载） */
async function resolveVirtualTrack(file, known) {
  const split = splitVirtualPath(file.path);
  const archiveId = split ? known?.archives.get(split.archivePath)?.id ?? null : null;
  return {
    sourceKind: 'archive_member',
    archiveId,
    memberPath: split?.memberPath ?? null,
    materializedState: 'archived',
    size: file.size ?? null,
    mtime: file.mtime ?? null,
    tagged: {},
  };
}

/** 普通磁盘文件下的曲目取信息：解析标签（现状逻辑，一字未改） */
async function resolveDiskTrack(file) {
  const fstat = await fsp.stat(file.path);
  return {
    sourceKind: 'file',
    archiveId: null,
    memberPath: null,
    materializedState: 'ready',
    size: fstat.size,
    mtime: Math.round(fstat.mtimeMs),
    tagged: file.kind === 'video' ? {} : await readTags(file.path),
  };
}

/**
 * 解出包内某个成员（P1 只用于封面这类小文件）。
 * 找不到条目时抛错，由调用方决定是否降级。
 */
async function readVirtualMember(vpath, known) {
  const split = splitVirtualPath(vpath);
  if (!split) throw new Error(`不是虚拟路径：${vpath}`);
  const cached = known?.archives?.get(split.archivePath);
  const info = cached?.info ?? await probeZip(split.archivePath);
  const entry = findEntry(info.entries, split.memberPath);
  if (!entry) throw new Error(`包内不存在该成员：${split.memberPath}`);
  return readEntryData(split.archivePath, entry);
}

/**
 * 普通音乐压缩包：由虚拟路径**推导**元数据，不解压任何数据。
 *
 * 为什么必须推导而不是读包内标签：P1 的硬约束是「扫描阶段零解压」。
 * 一个几百 MB 的包里若装着一张专辑，逐条解压读标签会让扫描慢几个数量级。
 * 因此这里只根据文件/目录名给出发行信息 —— 这也是发行路径同一口径的做法。
 *
 * 目录名作专辑名（多数压缩包会把专辑放在同名子目录里，与磁盘专辑一致），
 * 根目录平铺时退化为压缩包文件名。
 */
function albumRootOfVirtual(vpath) {
  const split = splitVirtualPath(vpath);
  if (!split) return vpath;
  const segs = split.memberPath.split('/').filter(Boolean);
  segs.pop();
  return virtualPath(split.archivePath, segs.join('/'));
}

/** 无「唱片集」标签时按目录归组，虚拟路径同样适用（见 config.mjs albumKeyOf） */
function readArchiveTags(vpath, file) {
  const split = splitVirtualPath(vpath);
  // file.name 是压缩包内的完整成员路径（如 `专辑/01 曲目.mp3`），先取到真正的文件名
  const fileName = path.posix.basename(String(file.name ?? ''));
  const base = baseNameOf(fileName);
  const folder = (() => {
    const segs = (split?.memberPath ?? '').split('/').filter(Boolean);
    segs.pop();
    return segs[segs.length - 1] ?? '';
  })();
  // 目录名作专辑名；根目录平铺时退化为压缩包文件名（注意压缩包路径是 Windows 路径）
  const album = folder || path.basename(split?.archivePath ?? '').replace(/\.zip$/i, '');
  // `艺术家 - 标题` 是这类包最常见的命名，拆开比整串塞进标题更有用
  const dash = base.match(/^(.+?)\s+-\s+(.+)$/);
  return {
    dir: albumRootOfVirtual(vpath),
    filename: fileName,
    ext: file.ext,
    title: dash ? dash[2].trim() : displayTitleOf(fileName),
    titleSource: 'filename',
    /** 曲目演唱者（来自 `艺术家 - 标题` 命名），仅用于显示 */
    artist: dash ? dash[1].trim() : null,
    /** 刻意留空：albumKeyOf 会因此按 dir 归组，避免多艺人原声被拆成多张专辑 */
    albumArtist: null,
    album: album || null,
    trackNo: extractTrackNo(fileName).no,
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
  };
}

/**
 * 解析（或重新解析）一个压缩包发行，并把三层模型写入数据库。
 *
 * P1 关键约束：**全程零解压写入**
 *   - 清单来自中央目录（probeZip），不解压任何音频数据；
 *   - 不读包内标签（readTags=false），标题由文件名推导；
 *   - 唯一解压对象是包内封面图（通常 0.5–5 MB）。
 *
 * @returns {Promise<object>} { archiveId, albumId, entries, tracks, skippedReason? }
 */
async function ingestArchive({ archivePath, libraryId, seen, known }) {
  if (known.archives.has(archivePath)) return { skipped: 'already' };

  let info;
  let summary;
  const t0 = Date.now();
  try {
    info = await probeZip(archivePath);
    summary = summarizeArchive(info);
  } catch (err) {
    // 结构损坏 / 不是真正的压缩包：如实登记，绝不静默跳过
    const status = err.code === 'NOT_ZIP' ? 'not_archive' : 'error';
    store.upsertArchive({
      path: archivePath, libraryId, format: 'zip', status, error: err.message,
    }, []);
    known.archives.set(archivePath, { id: store.getArchiveByPath(archivePath)?.id ?? null, info: null });
    scanState.archivesFailed += 1;
    pushError(`压缩包无法解析：${archivePath}（${err.message}）`);
    return { error: err.message };
  }

  const archiveId = store.upsertArchive({
    path: archivePath,
    libraryId,
    format: summary.format,
    entryCount: summary.entryCount,
    audioCount: summary.audioCount,
    imageCount: summary.imageCount,
    videoCount: summary.videoCount,
    packedBytes: summary.packedBytes,
    unpackedBytes: summary.unpackedBytes,
    encrypted: summary.encrypted,
    unsupported: summary.unsupported,
    nameEncoding: summary.nameEncoding,
    status: summary.unsupported ? 'partial' : 'ready',
    fileSize: summary.size,
    fileMtime: summary.mtime,
  }, info.entries);
  known.archives.set(archivePath, { id: archiveId, info });

  scanState.archivesParsed += 1;
  scanState.archiveEntries += summary.entryCount;
  scanState.archiveBytes += summary.unpackedBytes;
  scanState.archiveMs += Date.now() - t0;
  if (summary.unsupported) scanState.archivesUnsupported += 1;
  if (summary.encrypted) scanState.archivesEncrypted += 1;

  // 合成虚拟文件清单：压缩包文件本身充当一层虚拟目录（设计文档 §4.2）
  const virtualFiles = info.entries
    .filter((e) => e.kind !== 'dir')
    .map((e) => ({
      path: virtualPath(archivePath, e.name),
      name: path.posix.basename(e.name),
      ext: path.posix.extname(e.name).toLowerCase(),
      kind: e.kind,
      size: e.size,
      mtime: e.mtime,
    }));

  const audioFiles = virtualFiles.filter((f) => f.kind === 'audio');
  if (!audioFiles.length) {
    // 包里没有音频：登记但不出卡片（记录原因，便于排查）
    store.upsertArchive({ path: archivePath, libraryId, status: 'no_audio' }, info.entries);
    return { archiveId, tracks: 0, skippedReason: 'no_audio' };
  }

  /**
   * 关键分流：压缩包必须和磁盘文件走**同一条**判定规则。
   *
   * 曾经这里无条件调用 ingestRelease()，而 ingestRelease 会给每个发行打上
   * 「ASMR」标签 —— 于是任何放普通音乐（游戏原声、OST）的压缩包都会被误标为
   * 音声并挂上 ASMR 标签。磁盘文件有 locateRelease() 兜底，压缩包却漏了。
   *
   * 现在：包内有 RJ 号的成员才进音声三层模型；其余按普通音乐专辑处理。
   */
  const rjMembers = audioFiles.filter((f) => locateRelease(f.path));
  const plainMembers = audioFiles.filter((f) => !locateRelease(f.path));

  const result = { tracks: 0 };
  if (rjMembers.length) {
    const r = await ingestRelease({
      root: archivePath, libraryId, seen, files: virtualFiles, readTags: false, known,
    });
    result.tracks = (result.tracks ?? 0) + (r.tracks ?? 0);
  }
  if (plainMembers.length) {
    result.tracks = (result.tracks ?? 0) + await ingestMusicArchiveMembers({
      archivePath, archiveId, members: plainMembers, libraryId, seen,
    });
  }
  scanState.archiveTracks = (scanState.archiveTracks ?? 0) + (result.tracks ?? 0);
  return { archiveId, ...result };
}

/**
 * 把「不含 RJ 号」的包内成员按普通音乐专辑入库（零解压）。
 * 与磁盘音乐分支共用 resolveAlbumForTrack + upsertTrack 的落库口径。
 */
async function ingestMusicArchiveMembers({ archivePath, archiveId, members, libraryId, seen }) {
  let n = 0;
  for (const file of members) {
    const vpath = file.path;
    try {
      const existing = store.findTrackByPath(vpath);
      if (existing && existing.size === file.size && existing.mtime === file.mtime) {
        seen.add(vpath);
        scanState.skipped += 1;
        continue;
      }
      const tags = readArchiveTags(vpath, file);
      /**
       * albumArtist / artist 一律传 null：albumKeyOf 会退回「按 dir 归组」，
       * 于是同一目录下的包内曲目必然落进同一张专辑。
       * 曲目演唱者只用于显示（tags.artist），不参与分组。
       */
      const resolved = store.resolveAlbumForTrack({
        id: existing?.id,
        album: tags.album,
        albumArtist: null,
        artist: null,
        dir: tags.dir,
        year: tags.year,
        genre: tags.genre,
      });
      if (resolved.action === 'created') scanState.albumsCreated += 1;
      if (resolved.action === 'merged') scanState.albumsMerged += 1;

      // 按目录判定 ASMR 标签（压缩包成员同样看虚拟路径里的目录名）
      syncAsmrTag(resolved.albumId, vpath);

      store.upsertTrack({
        path: vpath,
        dir: tags.dir,
        libraryId,
        filename: tags.filename,
        ext: tags.ext,
        size: file.size,
        mtime: file.mtime,
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
        duration: null,
        bitrate: null,
        sampleRate: null,
        channels: null,
        codec: null,
        container: null,
        titleSource: tags.titleSource,
        hasCover: false,
        parseError: null,
        addedAt: existing ? undefined : Date.now(),
        // 包内成员登记为「归档态」，播放时按需解码（P2）
        sourceKind: 'archive_member',
        archiveId: archiveId ?? null,
        memberPath: splitVirtualPath(vpath)?.memberPath ?? null,
        materializedState: 'archived',
      });
      seen.add(vpath);
      if (existing) scanState.updated += 1;
      else scanState.added += 1;
      n += 1;
    } catch (err) {
      pushError(`包内曲目入库失败：${vpath}（${err.code ?? err.message}）`);
    } finally {
      scanState.processed += 1;
    }
  }
  return n;
}

/**
 * 只重新解析一个音声发行（人工合并结论生效 / 手动刷新用），不触碰其它专辑。
 */
export async function rescanReleaseRoot({ releaseRoot, libraryId }) {
  if (isWriting()) throw new Error('正在写回文件，请稍后再试');
  if (!releaseRoot) throw new Error('缺少发行根路径');
  const seen = new Set();
  const known = { archives: new Map() };
  // 发行根本身是压缩包时，走包内挂载；否则按目录重扫
  const result = isArchiveName(releaseRoot) && looksLikeZip(releaseRoot)
    ? await ingestArchive({ archivePath: releaseRoot, libraryId, seen, known })
    : await ingestRelease({ root: releaseRoot, libraryId, seen });
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
 *
 * `files` 非空时表示成员清单由外部注入（压缩包），此时 root 是虚拟发行根，
 * 且 readTags 应传 false —— P1 不对压缩包做任何解压。
 */
async function ingestRelease({ root, libraryId, seen, files = null, readTags = true, known = null }) {
  const existingAlbum = store.findVoiceAlbum(root);
  const decisions = existingAlbum
    ? store.getMergeDecisions(existingAlbum.id)
    : { merge: [], separate: [] };

  const analysis = await analyzeRelease(root, { readTags, decisions, files });

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

      // 曲目信息来源：压缩包成员只登记清单，**不解压**（P1）；磁盘文件解析标签
      let src;
      try {
        src = isVirtualPath(filePath)
          ? await resolveVirtualTrack(entry.file, known)
          : await resolveDiskTrack(entry.file);
      } catch (err) {
        // 文件在解析与写入之间消失：如实记录，不静默丢弃
        pushError(`曲目跳过：${filePath}（${err.code ?? err.message}）`);
        continue;
      }
      const { tagged } = src;
      if (src.sourceKind === 'archive_member' && !src.archiveId) continue;

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
        size: src.size,
        mtime: src.mtime,
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
        sourceKind: src.sourceKind,
        archiveId: src.archiveId,
        memberPath: src.memberPath,
        materializedState: src.materializedState,
      });
      trackCount += 1;
    }
  }

  // 封面（R13）：只在尚未手工设置过封面时套用
  if (analysis.cover && !existingAlbum?.cover_file) {
    try {
      const buf = isVirtualPath(analysis.cover.path)
        ? await readVirtualMember(analysis.cover.path, known)
        : await fsp.readFile(analysis.cover.path);
      if (buf) {
        const cover = await persistCoverImage(buf, detectImageMime(buf), 'manual');
        store.applyCover(albumId, cover);
      }
    } catch { /* 封面失败不影响曲目入库 */ }
  }

  scanState.albumsCreated += existingAlbum ? 0 : 1;
  scanState.added += trackCount;

  /**
   * 自动维护「ASMR」标签：**只按目录名判定**（见 isUnderAsmrFolder）。
   * 曾经这里无条件给每个音声发行打上 ASMR 标签，导致放在普通音乐目录里的
   * 游戏原声（带 RJ 号或压缩包）也被误标成 ASMR。
   */
  syncAsmrTag(albumId, root);

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

    const walked = await walkAudioFiles(lib.path);
    const allFiles = walked.files;
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
    /** 本次扫描已登记的压缩包：{ path → { id, info } } */
    const known = { archives: new Map() };

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

    // 压缩包（P1 只读挂载）：清单解析零解压，逐个登记并合成音声发行
    if (walked.archives.length && !scanState.cancelRequested) {
      scanState.phase = '解析压缩包';
      scanState.archivesFound += walked.archives.length;
      for (const archivePath of walked.archives) {
        if (scanState.cancelRequested) break;
        try {
          const r = await ingestArchive({ archivePath, libraryId: lib.id, seen, known });
          if (r?.tracks) scanState.releasesIngested = (scanState.releasesIngested ?? 0) + 1;
        } catch (err) {
          scanState.archivesFailed += 1;
          pushError(`压缩包处理失败：${archivePath}（${err.message}）`);
          // 保守处理：该包已登记的曲目一律视为已见，避免被清理阶段误删
          // （虚拟路径首段是 NUL，不能用 trackPathsUnder 前缀匹配）
          const archiveId = known.archives.get(archivePath)?.id ?? store.getArchiveByPath(archivePath)?.id;
          if (archiveId) {
            for (const p of store.trackPathsInArchive(archiveId)) seen.add(p);
          }
        }
      }
      scanState.phase = '解析标签';
    }

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

          // 按目录判定 ASMR 标签（同一专辑会重复调用，但结果是幂等的）
          syncAsmrTag(resolved.albumId, file);

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
      const trackPaths = store.trackPathsInLibrary(lib.id);
      for (const p of trackPaths) {
        if (!seen.has(p)) {
          store.deleteTrackByPath(p);
          scanState.removed += 1;
        }
      }
      // 压缩包消失 → 连同登记与成员清单一并删除（曲目已在上一步清掉）
      for (const arch of store.listArchives({ libraryId: lib.id })) {
        if (!known.archives.has(arch.path)) {
          const r = store.deleteArchive(arch.id);
          scanState.archivesRemoved += 1;
          scanState.removed += r.tracks;
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
