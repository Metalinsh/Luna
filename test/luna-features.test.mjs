/**
 * Luna 新增能力测试：社团 / 喜欢 / 全部曲目只含普通音乐。
 * 使用独立临时库，不触碰用户数据。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-luna-'));
process.env.LAM_DATA_DIR = dataDir;

let store;
let musicAlbumId;
let voiceAlbumId;

before(async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  store = await import('../server/db.mjs');

  // 一张普通音乐专辑
  const music = store.resolveAlbumForTrack({
    album: '普通专辑', albumArtist: '某歌手', artist: '某歌手', dir: 'E:\\Music\\Album\\普通专辑',
  });
  musicAlbumId = music.albumId;
  store.upsertTrack({
    path: 'E:\\Music\\Album\\普通专辑\\01 甲.flac', dir: 'E:\\Music\\Album\\普通专辑',
    filename: '01 甲.flac', ext: '.flac', size: 10, mtime: 1,
    title: '甲', artist: '某歌手', albumArtist: '某歌手', album: '普通专辑',
    albumKey: music.albumKey, albumId: music.albumId, trackNo: 1,
  });

  // 一个音声发行（三层模型）
  const root = 'E:\\Music\\ASMR\\[RJ99999999]测试音声';
  voiceAlbumId = store.upsertVoiceAlbum({
    releaseRoot: root, rjCode: 'RJ99999999', title: '测试音声', titleSource: 'folder',
  });
  const verId = store.upsertAlbumVersion(voiceAlbumId, {
    name: '本篇', nameKey: '本篇', groupKind: 'main', preferredFormat: 'wav',
  });
  store.upsertTrack({
    path: `${root}\\本篇（wav）\\01 音声.wav`, dir: `${root}\\本篇（wav）`,
    filename: '01 音声.wav', ext: '.wav', size: 10, mtime: 1,
    title: '音声轨', album: '测试音声', albumKey: store.voiceAlbumKey(root),
    albumId: voiceAlbumId, trackNo: 1, versionId: verId, trackKey: '音声轨',
    fileKind: 'audio', isBonus: false,
  });
});

test('全部曲目只收录普通音乐专辑的曲目', () => {
  const rows = store.listLooseTracks({});
  assert.equal(rows.length, 1, '应只有普通音乐的 1 首');
  assert.equal(rows[0].album_title, '普通专辑');
  assert.equal(store.countLooseTracks({}), 1, '计数必须与列表同口径');

  // 显式要求时才包含音声
  const all = store.listLooseTracks({ includeVoice: true });
  assert.equal(all.length, 2);
  assert.equal(store.countLooseTracks({ includeVoice: true }), 2);
});

test('全部曲目：搜索也遵守同一口径', () => {
  assert.equal(store.listLooseTracks({ q: '音声轨' }).length, 0, '搜音声轨不应命中');
  assert.equal(store.listLooseTracks({ q: '甲' }).length, 1);
});

test('喜欢：可标记、可取消、可只列喜欢的作品', () => {
  assert.equal(store.listAlbums({ favoriteOnly: true }).length, 0);

  store.setAlbumFavorite(musicAlbumId, true);
  const favs = store.listAlbums({ favoriteOnly: true });
  assert.equal(favs.length, 1);
  assert.equal(favs[0].id, musicAlbumId);
  assert.equal(favs[0].favorite, true, '列表要带出 favorite 字段供界面点亮');
  assert.equal(store.countAlbumsFiltered({ favoriteOnly: true }), 1);

  store.setAlbumFavorite(musicAlbumId, false);
  assert.equal(store.listAlbums({ favoriteOnly: true }).length, 0);
  assert.equal(store.countAlbumsFiltered({ favoriteOnly: true }), 0);
});

test('社团：写入后可被检索命中', () => {
  assert.equal(store.setAlbumCircle(voiceAlbumId, '  上海飯店  '), '上海飯店', '首尾空白应被裁掉');

  const hit = store.listAlbums({ q: '上海飯店' });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].id, voiceAlbumId);
  assert.equal(hit[0].circle, '上海飯店');
  assert.equal(store.countAlbumsFiltered({ q: '上海飯店' }), 1);

  // 部分匹配也应命中
  assert.equal(store.listAlbums({ q: '飯店' }).length, 1);

  // 清空
  assert.equal(store.setAlbumCircle(voiceAlbumId, ''), null);
  assert.equal(store.listAlbums({ q: '上海飯店' }).length, 0);
});

test('RJ 号也可作为检索依据', () => {
  const hit = store.listAlbums({ q: 'RJ99999999' });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].id, voiceAlbumId);
});

test('搜索项数（ALBUM_SEARCH_PARAMS）与实际占位符一致', () => {
  // 参数个数写错会导致 SQLite 绑定错误，这里用一次多条件查询兜底
  const rows = store.listAlbums({ q: '甲' });
  assert.ok(Array.isArray(rows));
  assert.equal(store.countAlbumsFiltered({ q: '甲' }), 1);
});

/* ------------------------------------------------ 收藏拆分 / 单曲喜欢 */

test('专辑收藏可按作品类型拆分（喜欢的ASMR / 喜欢的专辑）', () => {
  store.setAlbumFavorite(musicAlbumId, true);
  store.setAlbumFavorite(voiceAlbumId, true);

  const asmr = store.listAlbums({ favoriteOnly: true, kind: 'voice' });
  const albums = store.listAlbums({ favoriteOnly: true, kind: 'music' });
  assert.equal(asmr.length, 1);
  assert.equal(asmr[0].id, voiceAlbumId);
  assert.equal(albums.length, 1);
  assert.equal(albums[0].id, musicAlbumId);
  assert.equal(store.countAlbumsFiltered({ favoriteOnly: true, kind: 'voice' }), 1);
  assert.equal(store.countAlbumsFiltered({ favoriteOnly: true, kind: 'music' }), 1);

  store.setAlbumFavorite(musicAlbumId, false);
  store.setAlbumFavorite(voiceAlbumId, false);
});

test('单曲喜欢：普通音乐可收藏，音声曲目被拒绝', () => {
  const musicTracks = store.listLooseTracks({});
  assert.ok(musicTracks.length >= 1);
  const musicTrackId = musicTracks[0].id;

  const on = store.setTrackFavorite(musicTrackId, true);
  assert.equal(on.ok, true);
  assert.equal(on.skipped, false);
  assert.equal(on.favorite, true);
  assert.equal(store.countFavoriteTracks(), 1);

  const list = store.listLooseTracks({ favoriteOnly: true });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, musicTrackId);
  assert.equal(store.countLooseTracks({ favoriteOnly: true }), 1);

  // 音声曲目：不入库、不计数
  const voiceTrack = store.listLooseTracks({ includeVoice: true })
    .find((t) => t.album_kind === 'voice');
  assert.ok(voiceTrack, '应存在音声曲目');
  const blocked = store.setTrackFavorite(voiceTrack.id, true);
  assert.equal(blocked.skipped, true);
  assert.equal(blocked.favorite, false);
  assert.equal(store.countFavoriteTracks(), 1, '音声曲目不应进入收藏计数');

  store.setTrackFavorite(musicTrackId, false);
  assert.equal(store.countFavoriteTracks(), 0);
});

test('社团批量套用：可按名称找到其它音声发行', () => {
  const a = store.upsertVoiceAlbum({
    releaseRoot: 'E:\\Music\\ASMR\\[RJ11111111][上海飯店]作品甲', rjCode: 'RJ11111111',
    title: '作品甲', titleSource: 'folder',
  });
  const b = store.upsertVoiceAlbum({
    releaseRoot: 'E:\\Music\\ASMR\\[RJ22222222][上海飯店]作品乙', rjCode: 'RJ22222222',
    title: '作品乙（标题里没有社团名）', titleSource: 'tag',
  });

  const others = store.voiceAlbumsMatching('上海飯店', { excludeId: a })
    .filter((r) => /上海飯店/.test(r.release_root) || /上海飯店/.test(r.title));
  const ids = others.map((r) => r.id);
  assert.ok(ids.includes(b), '应通过发行根路径匹配到作品乙');

  store.setAlbumCircleBulk(ids, '上海飯店');
  assert.equal(store.getAlbumById(b).circle, '上海飯店');
  assert.equal(store.getAlbumById(a).circle, null, '被排除的自身不应被写入');

  // 艺术家同理
  store.setAlbumArtistBulk([b], '某艺术家');
  assert.equal(store.getAlbumById(b).album_artist, '某艺术家');
});
