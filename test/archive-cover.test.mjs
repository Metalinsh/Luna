/**
 * 压缩包封面挑选测试（普通音乐专辑与音声发行共用 pickCover 口径）。
 *
 * 纯函数测试：只喂条目清单，不碰磁盘、不碰数据库。
 * 真机端到端（扫出封面、包不被改动）由 tools/check/archive.mjs 与手工验收覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { virtualPath } from '../server/zip-reader.mjs';
import { pickArchiveCoverEntry } from '../server/scanner.mjs';

const ZIP = path.join('E:', 'Music', 'Album', '示例.zip');
/** 专辑虚拟目录：包根传 ''，子目录传目录名 */
const vdir = (rel) => virtualPath(ZIP, rel);
const img = (name, size = 1000) => ({ name, size, kind: 'image' });
const audio = (name, size = 5000) => ({ name, size, kind: 'audio' });

test('封面：包根平铺的专辑取根目录 cover.jpg', () => {
  const entries = [
    audio('01 曖昧サイボーグ.flac'),
    img('cover.jpg', 466702),
  ];
  const got = pickArchiveCoverEntry(entries, vdir(''));
  assert.equal(got?.name, 'cover.jpg');
});

test('封面：专辑子目录内、文件名不是 cover 的图片也能选中（按体积兜底）', () => {
  const entries = [
    audio('穢翼のユースティア ORIGINAL SOUND TRACK/Abgrund.mp3'),
    img('穢翼のユースティア ORIGINAL SOUND TRACK/穢翼のユースティア ORIGINAL SOUND TRACK.jpg', 953736),
    { name: '穢翼のユースティア ORIGINAL SOUND TRACK/readme.txt', size: 10, kind: 'other' },
  ];
  const got = pickArchiveCoverEntry(entries, vdir('穢翼のユースティア ORIGINAL SOUND TRACK'));
  assert.equal(path.posix.basename(got.name), '穢翼のユースティア ORIGINAL SOUND TRACK.jpg');
});

test('封面：多专辑包不串台，各取各自目录里的图', () => {
  const entries = [
    img('OST1/cover.jpg', 100),
    img('OST2/cover.jpg', 200),
    audio('OST1/01.mp3'),
    audio('OST2/01.mp3'),
  ];
  const one = pickArchiveCoverEntry(entries, vdir('OST1'));
  const two = pickArchiveCoverEntry(entries, vdir('OST2'));
  assert.equal(one?.name, 'OST1/cover.jpg');
  assert.equal(two?.name, 'OST2/cover.jpg');
});

test('封面：专辑目录里没有图时退回整包（根目录放图是常见写法）', () => {
  const entries = [
    img('封面.jpg', 300),
    audio('Disc1/01.mp3'),
  ];
  const got = pickArchiveCoverEntry(entries, vdir('Disc1'));
  assert.equal(got?.name, '封面.jpg');
});

test('封面：优先「封面」类子目录，胜过根目录的大图', () => {
  const entries = [
    img('扫描页/大图.jpg', 9_000_000),
    img('专辑/封面/cover.jpg', 500_000),
    audio('专辑/01.mp3'),
  ];
  const got = pickArchiveCoverEntry(entries, vdir('专辑'));
  assert.equal(got?.name, '专辑/封面/cover.jpg');
});

test('封面：命名优先级 cover > package > artwork（同级内）', () => {
  const entries = [
    img('专辑/artwork.png', 800_000),
    img('专辑/パッケージ.jpg', 900_000),
    img('专辑/cover.jpg', 100_000),
  ];
  const got = pickArchiveCoverEntry(entries, vdir('专辑'));
  assert.equal(path.posix.basename(got.name), 'cover.jpg');
});

test('封面：没有图片条目时返回 null，音频绝不被当成封面', () => {
  assert.equal(pickArchiveCoverEntry([audio('01.mp3'), audio('02.flac')], vdir('专辑')), null);
  assert.equal(pickArchiveCoverEntry([], vdir('')), null);
  assert.equal(pickArchiveCoverEntry(null, vdir('')), null);
});

test('封面：扩展名大小写与 png/webp 都能识别', () => {
  const upper = pickArchiveCoverEntry([img('专辑/COVER.JPG', 10)], vdir('专辑'));
  assert.equal(path.posix.basename(upper.name), 'COVER.JPG');
  const webp = pickArchiveCoverEntry([img('专辑/封面.webp', 10)], vdir('专辑'));
  assert.equal(path.posix.basename(webp.name), '封面.webp');
});

test('封面：目录前缀不误伤同名前缀的兄弟目录', () => {
  const entries = [
    img('OST10/cover.jpg', 10),
    audio('OST1/01.mp3'),
  ];
  // OST1 的子树里没有图 → 退回整包，因此会拿到 OST10 的图（与 ASMR 的整包兜底一致）
  const got = pickArchiveCoverEntry(entries, vdir('OST1'));
  assert.equal(got?.name, 'OST10/cover.jpg');

  // 两个目录都有图时，必须各取各的（前缀不能相互匹配）
  const both = [
    img('OST1/cover.jpg', 10),
    img('OST10/cover.jpg', 20),
  ];
  assert.equal(pickArchiveCoverEntry(both, vdir('OST1'))?.name, 'OST1/cover.jpg');
  assert.equal(pickArchiveCoverEntry(both, vdir('OST10'))?.name, 'OST10/cover.jpg');
});
