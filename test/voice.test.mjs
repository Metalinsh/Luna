/**
 * 音声三层模型的数据层测试（设计文档《音声专辑设计》第 4 节）。
 * 用独立的临时库，不触碰用户的真实数据。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-voice-'));
process.env.LAM_DATA_DIR = dataDir;

let store;

before(async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  store = await import('../server/db.mjs');
});

const ROOT = 'E:\\Music\\[RJ01113481]某音声作品';

test('音声发行卡片：按发行根唯一，并记录 RJ 号与特典标记', () => {
  const id = store.upsertVoiceAlbum({
    releaseRoot: ROOT,
    rjCode: 'RJ01113481',
    title: '某音声作品',
    titleSource: 'folder',
    hasBonus: true,
    hasVideo: true,
  });
  assert.ok(id > 0);

  const album = store.findVoiceAlbum(ROOT);
  assert.equal(album.id, id);
  assert.equal(album.kind, 'voice');
  assert.equal(album.is_voice, true);
  assert.equal(album.rj_code, 'RJ01113481');
  assert.equal(album.has_bonus, true);
  assert.equal(album.has_video, true);

  // 同一个发行根重复写入应复用同一张卡
  const again = store.upsertVoiceAlbum({
    releaseRoot: ROOT, rjCode: 'RJ01113481', title: '某音声作品', titleSource: 'folder',
  });
  assert.equal(again, id, '同一发行根不应重复建卡');
});

test('发行标题：内嵌标签优先于文件夹名', () => {
  const root = 'E:\\Music\\[RJ00000001]文件夹名版本';
  const id = store.upsertVoiceAlbum({
    releaseRoot: root, rjCode: 'RJ00000001', title: '文件夹名版本', titleSource: 'folder',
  });
  store.upsertVoiceAlbum({
    releaseRoot: root, rjCode: 'RJ00000001', title: '标签里的真标题', titleSource: 'tag',
  });
  assert.equal(store.getAlbumById(id).title, '标签里的真标题');

  // 反向：已有标签标题时，后续的文件夹名不应把标题覆盖回去
  store.upsertVoiceAlbum({
    releaseRoot: root, rjCode: 'RJ00000001', title: '文件夹名版本', titleSource: 'folder',
  });
  assert.equal(store.getAlbumById(id).title, '标签里的真标题');
});

test('版本层：写入、查询与格式优先标记', () => {
  const albumId = store.findVoiceAlbum(ROOT).id;
  const wav = store.upsertAlbumVersion(albumId, {
    name: '本篇', nameKey: '本篇', groupKind: 'main', preferredFormat: 'wav',
    fileCount: 24, totalBytes: 1000,
  });
  const mp3Only = store.upsertAlbumVersion(albumId, {
    name: '04_Voice(声のみ)', nameKey: '04voice声のみ', groupKind: 'main', preferredFormat: 'mp3',
    fileCount: 14, totalBytes: 500,
  });
  store.upsertAlbumVersion(albumId, {
    name: '特典曲', nameKey: '特典曲', groupKind: 'bonus', preferredFormat: 'wav',
    fileCount: 2, totalBytes: 100,
  });
  assert.ok(wav > 0 && mp3Only > 0 && mp3Only !== wav);

  const versions = store.listAlbumVersions(albumId);
  assert.equal(versions.length, 3);
  const onlyMp3 = versions.find((v) => v.name === '04_Voice(声のみ)');
  assert.equal(onlyMp3.preferred_format, 'mp3', '仅 mp3 存在的版本必须保留 mp3 格式');
  assert.equal(onlyMp3.group_kind, 'main');
  assert.ok(versions.some((v) => v.group_kind === 'bonus'));

  // 同 name_key 再写入应更新而不是新增
  const again = store.upsertAlbumVersion(albumId, {
    name: '本篇', nameKey: '本篇', groupKind: 'main', preferredFormat: 'wav',
    fileCount: 30, totalBytes: 2000,
  });
  assert.equal(again, wav);
  assert.equal(store.listAlbumVersions(albumId).find((v) => v.id === wav).file_count, 30);
});

test('版本清理：只保留本次解析出的版本', () => {
  const albumId = store.findVoiceAlbum(ROOT).id;
  const keep = store.listAlbumVersions(albumId).filter((v) => v.group_kind === 'main').map((v) => v.id);
  store.pruneAlbumVersions(albumId, keep);
  const left = store.listAlbumVersions(albumId);
  assert.equal(left.length, keep.length);
  assert.ok(left.every((v) => v.group_kind === 'main'));
});

test('人工合并结论：可写入、可读回，且与同一发行的结论隔离', () => {
  const albumId = store.findVoiceAlbum(ROOT).id;
  assert.deepEqual(store.getMergeDecisions(albumId), { merge: [], separate: [] });

  store.setMergeDecision(albumId, '甲通話通話', '甲通話', 'merge');
  let d = store.getMergeDecisions(albumId);
  assert.equal(d.merge.length, 1);
  assert.equal(d.separate.length, 0);

  // 同一对重复写入应改判而不是新增
  store.setMergeDecision(albumId, '甲通話', '甲通話通話', 'separate');
  d = store.getMergeDecisions(albumId);
  assert.equal(d.merge.length, 0);
  assert.equal(d.separate.length, 1);

  // 键顺序不影响同一对判定
  const other = store.upsertVoiceAlbum({
    releaseRoot: 'E:\\Music\\[RJ00000002]另一个发行', rjCode: 'RJ00000002',
    title: '另一个发行', titleSource: 'folder',
  });
  assert.deepEqual(store.getMergeDecisions(other), { merge: [], separate: [] },
    '不同发行之间的合并结论不应互相影响');
});

test('音声曲目查询：带出版本信息，供界面按轨号分组', () => {
  const albumId = store.findVoiceAlbum(ROOT).id;
  // 上一个测试清理掉了特典版本，这里补回来（各测试互相独立）
  store.upsertAlbumVersion(albumId, {
    name: '特典曲', nameKey: '特典曲', groupKind: 'bonus', preferredFormat: 'wav',
    fileCount: 2, totalBytes: 100,
  });
  const versions = store.listAlbumVersions(albumId);
  const main = versions.find((v) => v.group_kind === 'main');
  const bonus = versions.find((v) => v.group_kind === 'bonus');
  assert.ok(main && bonus, '主版本与特典版本都应存在');

  const common = {
    dir: `${ROOT}\\本篇（wav）`,
    libraryId: null, filename: 'x.wav', ext: '.wav', size: 10, mtime: 1,
    albumKey: store.voiceAlbumKey(ROOT), albumId, title: '甲', trackNo: 1,
  };
  store.upsertTrack({
    ...common, path: `${ROOT}\\本篇（wav）\\01 甲.wav`,
    versionId: main.id, trackKey: '甲', fileKind: 'audio', isBonus: false,
  });
  store.upsertTrack({
    ...common, path: `${ROOT}\\本篇（wav）\\01 甲.mp4`, filename: 'x.mp4', ext: '.mp4',
    versionId: main.id, trackKey: '甲', fileKind: 'video', variantLabel: '有日文字幕', isBonus: false,
  });
  store.upsertTrack({
    ...common, path: `${ROOT}\\特典\\bonus.wav`, filename: 'bonus.wav', title: '特典曲',
    trackNo: null, versionId: bonus.id, trackKey: '特典曲', fileKind: 'audio', isBonus: true,
  });

  const rows = store.listVoiceTracks(albumId);
  assert.equal(rows.length, 3);
  const video = rows.find((r) => r.file_kind === 'video');
  assert.equal(video.variant_label, '有日文字幕', '视频子变体标签要保留');
  assert.equal(video.version_name, main.name);
  const bonusRow = rows.find((r) => r.is_bonus === 1);
  assert.equal(bonusRow.group_kind, 'bonus');
  assert.equal(bonusRow.version_name, bonus.name);

  // 按发行根列出曲目（供单发行重扫时清理失效条目）
  const under = store.trackPathsUnder(ROOT);
  assert.equal(under.length, 3);
  assert.ok(store.trackPathsUnder('E:\\Music\\[RJ00000002]另一个发行').length === 0,
    '不应列出其它发行下的曲目');
});
