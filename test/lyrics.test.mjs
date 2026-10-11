/**
 * 歌词模块测试（设计文档 5.7）：编码嗅探、LRC 解析、文件名匹配。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-lyrics-data-'));
const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-lyrics-music-'));
process.env.LAM_DATA_DIR = dataDir;

let lyrics;

before(async () => {
  lyrics = await import('../server/lyrics.mjs');
});

after(() => {
  /*
   * lyrics.mjs 现在会读 `archive_members` 清单（压缩包歌词匹配），
   * 因此本测试会间接打开临时库的 SQLite 句柄；Windows 上句柄未释放时
   * 删目录会 EPERM —— 清理失败不该让整份测试判负。
   * （与 gallery.test.mjs 同一处理方式。）
   */
  for (const dir of [dataDir, musicDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

/* ------------------------------------------------- 压缩包成员的歌词匹配 */

test('压缩包：包内 .vtt 按「完整音频名 + .vtt」匹配（实测 RJ01307571 命名）', async () => {
  const store = await import('../server/db.mjs');
  const archiveId = store.upsertArchive({
    path: 'E:\\Music\\ASMR\\含字幕包.zip', format: 'zip', entryCount: 4,
  }, [
    { name: '1.正篇/mp3/01.开场.mp3', kind: 'audio', size: 1000 },
    { name: '1.正篇/mp3/01.开场.mp3.vtt', kind: 'other', size: 100 },
    { name: '1.正篇/mp3/02.正文.mp3', kind: 'audio', size: 2000 },
    { name: '1.正篇/mp3/02.正文.mp3.vtt', kind: 'other', size: 200 },
  ]);
  const track = {
    id: 9001,
    archive_id: archiveId,
    member_path: '1.正篇/mp3/01.开场.mp3',
    path: `E:\\Music\\ASMR\\含字幕包.zip\u00001.正篇/mp3/01.开场.mp3`,
    filename: '01.开场.mp3',
    track_no: 1,
  };
  const found = lyrics.findArchiveLyricsMember(track, [track]);
  assert.equal(found?.level, 'l1v');
  assert.equal(found?.memberPath, '1.正篇/mp3/01.开场.mp3.vtt');

  // 另一条曲目各取各的，不串台
  const other = { ...track, id: 9002, member_path: '1.正篇/mp3/02.正文.mp3', filename: '02.正文.mp3', track_no: 2 };
  const found2 = lyrics.findArchiveLyricsMember(other, [other]);
  assert.equal(found2?.memberPath, '1.正篇/mp3/02.正文.mp3.vtt');
});

test('压缩包：同目录同名 .lrc 走 L1，且不跨目录匹配', async () => {
  const store = await import('../server/db.mjs');
  const archiveId = store.upsertArchive({
    path: 'E:\\Music\\ASMR\\目录隔离.zip', format: 'zip', entryCount: 5,
  }, [
    { name: 'A/01.mp3', kind: 'audio', size: 10 },
    { name: 'A/01.lrc', kind: 'other', size: 1 },
    { name: 'B/01.mp3', kind: 'audio', size: 10 },
    { name: 'B/01.lrc', kind: 'other', size: 1 },
    { name: 'readme.txt', kind: 'other', size: 1 },
  ]);
  const a = { id: 9101, archive_id: archiveId, member_path: 'A/01.mp3', filename: '01.mp3', track_no: 1 };
  const b = { id: 9102, archive_id: archiveId, member_path: 'B/01.mp3', filename: '01.mp3', track_no: 1 };
  assert.equal(lyrics.findArchiveLyricsMember(a, [a, b])?.memberPath, 'A/01.lrc');
  assert.equal(lyrics.findArchiveLyricsMember(b, [a, b])?.memberPath, 'B/01.lrc');
});

test('压缩包：只有 readme/台本时不会误配到曲目上', async () => {
  const store = await import('../server/db.mjs');
  const archiveId = store.upsertArchive({
    path: 'E:\\Music\\ASMR\\无字幕.zip', format: 'zip', entryCount: 4,
  }, [
    { name: '音声/tr01.mp3', kind: 'audio', size: 10 },
    { name: '音声/tr02.mp3', kind: 'audio', size: 10 },
    { name: 'りどみ.txt', kind: 'other', size: 1 },
    { name: '音声/使用方法.txt', kind: 'other', size: 1 },
  ]);
  const t = { id: 9201, archive_id: archiveId, member_path: '音声/tr01.mp3', filename: 'tr01.mp3', track_no: 1 };
  assert.equal(lyrics.findArchiveLyricsMember(t, [t]), null, '读我/说明文件不能当歌词');
});

test('压缩包：整专辑共用 album.lrc 也能命中', async () => {
  const store = await import('../server/db.mjs');
  const archiveId = store.upsertArchive({
    path: 'E:\\Music\\ASMR\\整专共用.zip', format: 'zip', entryCount: 3,
  }, [
    { name: '碟/01.mp3', kind: 'audio', size: 10 },
    { name: '碟/02.mp3', kind: 'audio', size: 10 },
    { name: '碟/album.lrc', kind: 'other', size: 1 },
  ]);
  const t = { id: 9301, archive_id: archiveId, member_path: '碟/01.mp3', filename: '01.mp3', track_no: 1 };
  const found = lyrics.findArchiveLyricsMember(t, [t]);
  assert.equal(found?.level, 'shared');
  assert.equal(found?.memberPath, '碟/album.lrc');
});

test('压缩包：非包内曲目（没有 archive_id）直接返回 null', () => {
  assert.equal(lyrics.findArchiveLyricsMember({ member_path: 'A/01.mp3' }, []), null);
  assert.equal(lyrics.findArchiveLyricsMember(null, []), null);
});

test('匹配阶梯：纯函数版本与磁盘口径一致（L1 优先于 L1v 与 L3）', () => {
  const files = ['01.开场.mp3.lrc', '01.开场.lrc', '01.开场.mp3.vtt', '无关文件.txt'];
  const hit = lyrics.matchLyricName({ files, stem: '01.开场', filename: '01.开场.mp3', trackNo: 1 });
  assert.equal(hit.name, '01.开场.lrc', 'L1（同名 .lrc）优先');
  const noSameName = lyrics.matchLyricName({
    files: ['01.开场.mp3.vtt', '无关文件.txt'], stem: '01.开场', filename: '01.开场.mp3', trackNo: 1,
  });
  assert.equal(noSameName.name, '01.开场.mp3.vtt', '没有同名时用 L1v');
  assert.equal(noSameName.level, 'l1v');
});


test('编码：UTF-8 BOM 被正确剥离并识别', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[00:01.00]你好', 'utf8')]);
  const { text, encoding } = lyrics.sniffDecode(buf);
  assert.equal(text, '[00:01.00]你好');
  assert.match(encoding, /UTF-8/);
});

test('编码：GBK 歌词被正确识别（中文老歌词的常见情况）', () => {
  // "中文歌词" 的 GBK 字节
  const gbk = Buffer.from([0xD6, 0xD0, 0xCE, 0xC4, 0xB8, 0xE8, 0xB4, 0xCA]);
  const { text, encoding } = lyrics.sniffDecode(gbk);
  assert.equal(text, '中文歌词');
  assert.match(encoding, /GB/);
});

test('编码：UTF-8 无 BOM 正常解码', () => {
  const { text, encoding } = lyrics.sniffDecode(Buffer.from('[00:01.00]曖昧サイボーグ', 'utf8'));
  assert.equal(text, '[00:01.00]曖昧サイボーグ');
  assert.equal(encoding, 'UTF-8');
});

test('编码：UTF-16LE BOM', () => {
  const body = Buffer.from('歌词', 'utf16le');
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
  const { text, encoding } = lyrics.sniffDecode(buf);
  assert.equal(text, '歌词');
  assert.equal(encoding, 'UTF-16LE');
});

/* ---------------------------------------------------------------- LRC 解析 */

const LRC = [
  '[ti:测试歌曲]',
  '[ar:测试艺术家]',
  '[offset:+500]',
  '[00:01.00]第一行',
  '[00:03.50]第二行',
  '[00:05.00][00:20.00]重复出现的一句',
  '[00:08.00]原文',
  '[00:08.00]译文',
  '',
  '[00:10.00]',
].join('\n');

test('LRC：解析时间标签、元信息与 offset', () => {
  const parsed = lyrics.parseLrc(LRC);
  assert.equal(parsed.synced, true);
  assert.equal(parsed.meta.ti, '测试歌曲');
  assert.equal(parsed.meta.ar, '测试艺术家');
  assert.equal(parsed.offset, 500);
  // offset +500 表示歌词提前 500ms
  assert.equal(parsed.lines[0].time, 500);
  assert.equal(parsed.lines[0].text, '第一行');
  assert.equal(parsed.lines[1].time, 3000);
});

test('LRC：一行多时间戳生成多条记录，且按时间排序', () => {
  const parsed = lyrics.parseLrc(LRC);
  const repeated = parsed.lines.filter((l) => l.text === '重复出现的一句');
  assert.equal(repeated.length, 2, '同一句出现两个时间点');
  assert.deepEqual(repeated.map((l) => l.time), [4500, 19500]);
  const times = parsed.lines.map((l) => l.time);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), '整体有序');
});

test('LRC：同一时间戳的多行合并为译文', () => {
  const parsed = lyrics.parseLrc(LRC);
  const line = parsed.lines.find((l) => l.text === '原文');
  assert.ok(line);
  assert.equal(line.translation, '译文');
  assert.equal(parsed.lines.filter((l) => l.text === '译文').length, 0, '译文不再单独占一行');
});

test('LRC：空文本行被忽略', () => {
  const parsed = lyrics.parseLrc(LRC);
  assert.ok(parsed.lines.every((l) => l.text.length > 0));
});

test('LRC：多种毫秒写法都支持', () => {
  const parsed = lyrics.parseLrc('[00:01]A\n[00:02.5]B\n[00:03.25]C\n[00:04.125]D\n[00:05:75]E');
  assert.deepEqual(parsed.lines.map((l) => l.time), [1000, 2500, 3250, 4125, 5750]);
});

test('LRC：无时间轴时退化为静态文本', () => {
  const parsed = lyrics.parseLrc('只是一段歌词\n第二行');
  assert.equal(parsed.synced, false);
  assert.deepEqual(parsed.lines.map((l) => l.text), ['只是一段歌词', '第二行']);
  assert.ok(parsed.lines.every((l) => l.time === null));
});

test('LRC：CRLF 与多余空行不影响解析', () => {
  const parsed = lyrics.parseLrc('[00:01.00]A\r\n\r\n\r\n[00:02.00]B\r\n');
  assert.deepEqual(parsed.lines.map((l) => l.text), ['A', 'B']);
});

/* ------------------------------------------------------------ 文件名匹配 */

function write(name, content = '[00:01.00]x') {
  fs.writeFileSync(path.join(musicDir, name), content, 'utf8');
}

test('匹配 L1：同目录同名 .lrc', async () => {
  const file = path.join(musicDir, 'song-a.flac');
  write('song-a.flac', 'binary');
  write('song-a.lrc');
  const found = await lyrics.findLyricsFile({ id: 1, path: file, filename: 'song-a.flac', dir: musicDir });
  assert.equal(found.level, 'l1');
  assert.equal(path.basename(found.path), 'song-a.lrc');
});

test('匹配 L2：去掉音轨号前缀后同名', async () => {
  const dir = path.join(musicDir, 'l2');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '02 - Passacaglia.flac'), 'binary');
  fs.writeFileSync(path.join(dir, 'Passacaglia.lrc'), '[00:01.00]x');
  const found = await lyrics.findLyricsFile({
    id: 2, path: path.join(dir, '02 - Passacaglia.flac'), filename: '02 - Passacaglia.flac', dir,
  });
  assert.equal(found.level, 'l2');
  assert.equal(path.basename(found.path), 'Passacaglia.lrc');
});

test('匹配 L2：按音轨号命名的 01.lrc', async () => {
  const dir = path.join(musicDir, 'l2b');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '01 Toccata.flac'), 'binary');
  fs.writeFileSync(path.join(dir, '01.lrc'), '[00:01.00]x');
  const found = await lyrics.findLyricsFile({
    id: 3, path: path.join(dir, '01 Toccata.flac'), filename: '01 Toccata.flac', dir, track_no: 1,
  });
  assert.equal(found.level, 'l2');
  assert.equal(path.basename(found.path), '01.lrc');
});

test('匹配 L3：相似度够高的文件名', async () => {
  const dir = path.join(musicDir, 'l3');
  fs.mkdirSync(dir, { recursive: true });
  const audio = path.join(dir, '07 Fantasia in G major BWV572.flac');
  fs.writeFileSync(audio, 'binary');
  fs.writeFileSync(path.join(dir, '07 Fantasia in G major.lrc'), '[00:01.00]x');
  const found = await lyrics.findLyricsFile({ id: 4, path: audio, filename: path.basename(audio), dir });
  assert.ok(found, '应匹配到相似文件');
  assert.equal(found.level, 'l3');
});

test('匹配：整专辑共用 album.lrc', async () => {
  const dir = path.join(musicDir, 'shared');
  fs.mkdirSync(dir, { recursive: true });
  const audio = path.join(dir, 'whatever-title.flac');
  fs.writeFileSync(audio, 'binary');
  fs.writeFileSync(path.join(dir, 'album.lrc'), '[00:01.00]x');
  const found = await lyrics.findLyricsFile({
    id: 5, path: audio, filename: 'whatever-title.flac', dir, album: '专辑名',
  });
  assert.equal(found.level, 'shared');
});

test('匹配：同名 .txt 作为无时间轴歌词', async () => {
  const dir = path.join(musicDir, 'txt');
  fs.mkdirSync(dir, { recursive: true });
  const audio = path.join(dir, 'plain.flac');
  fs.writeFileSync(audio, 'binary');
  fs.writeFileSync(path.join(dir, 'plain.txt'), '没有时间轴的歌词');
  const found = await lyrics.findLyricsFile({ id: 6, path: audio, filename: 'plain.flac', dir });
  assert.equal(found.level, 'txt');
});

test('匹配：目录里没有歌词文件时返回 null', async () => {
  const dir = path.join(musicDir, 'none');
  fs.mkdirSync(dir, { recursive: true });
  const audio = path.join(dir, 'bare.flac');
  fs.writeFileSync(audio, 'binary');
  const found = await lyrics.findLyricsFile({ id: 7, path: audio, filename: 'bare.flac', dir });
  assert.equal(found, null);
});

/* ------------------------------------------------------------ 端到端取歌词 */

test('端到端：读取 GBK 编码的 .lrc 并返回可滚动歌词', async () => {
  const dir = path.join(musicDir, 'e2e');
  fs.mkdirSync(dir, { recursive: true });
  const audio = path.join(dir, 'gbk-song.flac');
  fs.writeFileSync(audio, 'binary');
  // 用 GBK 写一行歌词：[00:01.00]中文歌词
  const prefix = Buffer.from('[00:01.00]', 'ascii');
  const gbkText = Buffer.from([0xD6, 0xD0, 0xCE, 0xC4, 0xB8, 0xE8, 0xB4, 0xCA]);
  fs.writeFileSync(path.join(dir, 'gbk-song.lrc'), Buffer.concat([prefix, gbkText]));

  const result = await lyrics.getLyricsForTrack({
    id: 8, path: audio, filename: 'gbk-song.flac', dir, lyrics_path: null,
  });
  assert.equal(result.available, true);
  assert.equal(result.source, 'lrc');
  assert.match(result.encoding, /GB/);
  assert.equal(result.synced, true);
  assert.equal(result.lines[0].text, '中文歌词');
  assert.equal(result.lines[0].time, 1000);
});

test('端到端：手动关联优先于自动匹配', async () => {
  const dir = path.join(musicDir, 'manual');
  fs.mkdirSync(dir, { recursive: true });
  const audio = path.join(dir, 'a.flac');
  fs.writeFileSync(audio, 'binary');
  fs.writeFileSync(path.join(dir, 'a.lrc'), '[00:01.00]自动匹配到的');
  const manualPath = path.join(dir, 'manual-pick.lrc');
  fs.writeFileSync(manualPath, '[00:02.00]手动指定的');

  const result = await lyrics.getLyricsForTrack({
    id: 9, path: audio, filename: 'a.flac', dir, lyrics_path: manualPath,
  });
  assert.equal(result.source, 'manual');
  assert.equal(result.lines[0].text, '手动指定的');
});

test('端到端：没有任何歌词时返回 available=false', async () => {
  const dir = path.join(musicDir, 'empty');
  fs.mkdirSync(dir, { recursive: true });
  const audio = path.join(dir, 'no-lyrics.flac');
  fs.writeFileSync(audio, 'binary');
  const result = await lyrics.getLyricsForTrack({ id: 10, path: audio, filename: 'no-lyrics.flac', dir });
  assert.equal(result.available, false);
  assert.deepEqual(result.lines, []);
});

test('相似度函数：归一化后比较', () => {
  assert.equal(lyrics.similarity('01 - Song.flac', 'Song.lrc'), 1);
  assert.ok(lyrics.similarity('Song (Live).flac', 'song.lrc') > 0.8, '括号后缀不影响匹配');
  assert.ok(lyrics.similarity('Fantasia in G major BWV572.flac', 'Fantasia in G major.lrc') > 0.8,
    '目录编号后缀不影响匹配');
  assert.ok(lyrics.similarity('完全不同的名字.flac', 'another.lrc') < 0.3);
});

test('相似度守卫：编号不同的曲目绝不互相匹配（防止挂错歌词）', () => {
  assert.equal(lyrics.similarity('01 Toccata.flac', '02 Toccata.lrc'), 0, '开头编号不同');
  assert.equal(lyrics.similarity('Part 1.flac', 'Part 10.lrc'), 0, '结尾编号不同');
  assert.ok(lyrics.similarity('01 Toccata.flac', '01 Toccata.lrc') === 1, '编号相同则正常匹配');
});

test('匹配 L3：编号不同的邻近文件不会被误配', async () => {
  const dir = path.join(musicDir, 'l3-guard');
  fs.mkdirSync(dir, { recursive: true });
  const audio = path.join(dir, '01 Toccata.flac');
  fs.writeFileSync(audio, 'binary');
  fs.writeFileSync(path.join(dir, '02 Toccata.lrc'), '[00:01.00]第二首的歌词');
  const found = await lyrics.findLyricsFile({
    id: 11, path: audio, filename: '01 Toccata.flac', dir, track_no: 1,
  });
  assert.equal(found, null, '不应把第二首的歌词挂到第一首上');
});

/* ============================================ 字幕格式（VTT / SRT / ASS）*/

test('VTT：解析时间轴与文本，剔除行内标签', () => {
  const raw = [
    'WEBVTT',
    'Kind: captions',
    'Language: zh-CN',
    '',
    'NOTE 这是一条注释',
    '不该被当成歌词',
    '',
    '1',
    '00:00:07.429 --> 00:00:11.539',
    '今天天气真的很好啊，<b>亲爱的</b>~',
    '',
    '2',
    '00:00:11.539 --> 00:00:15.000',
    '<c.yellow>太阳公公</c>身体这么好',
    '我也有精神干农活啦',
  ].join('\n');
  const p = lyrics.parseSubtitle(raw, '.vtt');
  assert.equal(p.synced, true);
  assert.equal(p.lines.length, 2, 'NOTE 块不应被当成字幕');
  assert.equal(p.lines[0].time, 7429);
  assert.equal(p.lines[0].text, '今天天气真的很好啊，亲爱的~', '行内标签应被剔除');
  assert.equal(p.lines[1].text, '太阳公公身体这么好 我也有精神干农活啦', '多行应合并为一条');
});

test('SRT：逗号毫秒分隔符', () => {
  const raw = [
    '1',
    '00:00:01,000 --> 00:00:03,500',
    '第一句',
    '',
    '2',
    '00:00:03,500 --> 00:00:06,000',
    '第二句',
  ].join('\n');
  const p = lyrics.parseSubtitle(raw, '.srt');
  assert.equal(p.synced, true);
  assert.equal(p.lines.length, 2);
  assert.equal(p.lines[0].time, 1000);
  assert.equal(p.lines[1].text, '第二句');
});

test('ASS：取 Dialogue 行并剥离覆盖码', () => {
  const raw = [
    '[Script Info]',
    'Title: 测试',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:07.42,0:00:10.92,Default,,0,0,0,,{\\pos(190,240)}第一句',
    'Dialogue: 0,0:00:10.92,0:00:14.00,Default,,0,0,0,,第二句\\N换行内容',
    'Comment: 0,0:00:14.00,0:00:15.00,Default,,0,0,0,,这是注释不该出现',
  ].join('\n');
  const p = lyrics.parseSubtitle(raw, '.ass');
  assert.equal(p.synced, true);
  assert.equal(p.lines.length, 2, 'Comment 行不应被解析');
  assert.equal(p.lines[0].time, 7420);
  assert.equal(p.lines[0].text, '第一句', 'ASS 覆盖码应被剥离');
  assert.equal(p.lines[1].text, '第二句 换行内容');
});

test('VTT：无时间轴时视为不可用', () => {
  const p = lyrics.parseSubtitle('WEBVTT\n\n只有一行没有时间的内容', '.vtt');
  assert.equal(p.synced, false);
  assert.equal(p.lines.length, 0);
});

/* ============================================ 文件名匹配：VTT / 台本镜像 */

test('匹配 L1v：<完整音频文件名>.vtt（实测 RJ01113481 的命名）', async () => {
  const dir = path.join(musicDir, 'vtt-naming');
  fs.mkdirSync(dir, { recursive: true });
  const audio = path.join(dir, '00.结婚一周年纪念日.wav');
  fs.writeFileSync(audio, 'binary');
  fs.writeFileSync(path.join(dir, '00.结婚一周年纪念日.wav.vtt'),
    'WEBVTT\n\n00:00:07.429 --> 00:00:11.539\n今天天气真的很好啊');
  const found = await lyrics.findLyricsFile({
    id: 21, path: audio, filename: '00.结婚一周年纪念日.wav', dir, track_no: 0,
  });
  assert.ok(found, '应命中 .wav.vtt');
  assert.equal(found.level, 'l1v');
  assert.ok(found.path.endsWith('00.结婚一周年纪念日.wav.vtt'));
});

test('同目录存在 .lrc 与 .vtt 时优先 .lrc（同步格式优先级）', async () => {
  const dir = path.join(musicDir, 'priority');
  fs.mkdirSync(dir, { recursive: true });
  const audio = path.join(dir, '01 测试.wav');
  fs.writeFileSync(audio, 'binary');
  fs.writeFileSync(path.join(dir, '01 测试.lrc'), '[00:01.00]LRC 内容');
  fs.writeFileSync(path.join(dir, '01 测试.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nVTT 内容');
  const found = await lyrics.findLyricsFile({ id: 22, path: audio, filename: '01 测试.wav', dir, track_no: 1 });
  assert.ok(found.path.endsWith('.lrc'));
});

test('匹配 script：台本镜像目录里的同名 .txt（实测 RJ01113481 结构）', async () => {
  const root = path.join(musicDir, 'asmr-release');
  const audioDir = path.join(root, '作品名', '本篇（wav）');
  const scriptDir = path.join(root, '大家一起来翻译_台本', '作品名', '本篇（wav）');
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(scriptDir, { recursive: true });
  const audio = path.join(audioDir, '00.结婚一周年纪念日.wav');
  fs.writeFileSync(audio, 'binary');
  fs.writeFileSync(path.join(scriptDir, '00.结婚一周年纪念日.txt'), '这是台本内容');

  const found = await lyrics.findLyricsFile({
    id: 23, path: audio, filename: '00.结婚一周年纪念日.wav',
    dir: audioDir, track_no: 0, album: '作品名',
  });
  assert.ok(found, '应命中镜像台本目录');
  assert.equal(found.level, 'script');
  assert.ok(found.path.includes('大家一起来翻译_台本'));

  const got = await lyrics.getLyricsForTrack({
    id: 23, path: audio, filename: '00.结婚一周年纪念日.wav',
    dir: audioDir, track_no: 0, album: '作品名',
  }, []);
  assert.equal(got.available, true);
  assert.equal(got.synced, false, '台本 .txt 无时间轴');
  assert.ok(got.lines.length >= 1);
});

test('同目录有 .vtt 时不使用镜像台本（同步格式优先）', async () => {
  const root = path.join(musicDir, 'asmr-release-2');
  const audioDir = path.join(root, '作品名', '本篇（wav）');
  const scriptDir = path.join(root, '台本', '作品名', '本篇（wav）');
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(scriptDir, { recursive: true });
  const audio = path.join(audioDir, '01.第二轨.wav');
  fs.writeFileSync(audio, 'binary');
  fs.writeFileSync(path.join(audioDir, '01.第二轨.wav.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n同步字幕');
  fs.writeFileSync(path.join(scriptDir, '01.第二轨.txt'), '台本文字');
  const found = await lyrics.findLyricsFile({
    id: 24, path: audio, filename: '01.第二轨.wav', dir: audioDir, track_no: 1, album: '作品名',
  });
  assert.equal(found.level, 'l1v', '应优先同目录字幕');
});
