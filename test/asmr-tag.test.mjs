/**
 * ASMR 自动打标规则（用户指定）：
 *   **音乐库文件夹名称为 ASMR 的，其中的专辑统一视为 ASMR；不在其中的专辑均非 ASMR。**
 *
 * 只按路径判定，与是否带 RJ 号、是否压缩包都无关。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isUnderAsmrFolder } from '../server/scanner.mjs';

test('ASMR 判定：目录段精确匹配，与大小写无关', () => {
  const yes = [
    'E:\\Music\\ASMR\\[RJ01182623]作品\\01.mp3',
    'E:\\Music\\ASMR\\01.mp3',
    'E:\\ASMR\\单曲.flac',
    'D:/Music/asmr/album/track.wav',
    'D:/music/AsMr/x.m4a',
    // 压缩包虚拟路径：NUL 之后是包内成员路径
    'E:\\Music\\ASMR\\作品.zip\u0000作品/01.mp3',
    'E:\\Music\\Album\\x.zip\u0000ASMR/作品/01.mp3',
  ];
  for (const p of yes) {
    assert.equal(isUnderAsmrFolder(p), true, `应判为 ASMR：${p}`);
  }
});

test('ASMR 判定：非 ASMR 目录一律为否', () => {
  const no = [
    'E:\\Music\\Album\\a.flac',
    'E:\\Music\\Album\\穢翼のユースティア ORIGINAL SOUND TRACK.zip\u0000穢翼/01.mp3',
    'E:\\Music\\游戏原声\\[RJ123456]作品\\01.mp3',
    // 只是前缀相同，不是同名的目录段
    'E:\\Music\\ASMRStuff\\a.mp3',
    'E:\\Music\\ASMR-旧\\a.mp3',
    'E:\\Music\\MyASMR\\a.mp3',
    'E:\\Music\\a.flac',
  ];
  for (const p of no) {
    assert.equal(isUnderAsmrFolder(p), false, `不应判为 ASMR：${p}`);
  }
});

test('ASMR 判定：空值与异常输入不抛错', () => {
  for (const p of [null, undefined, '', 0, {}]) {
    assert.equal(isUnderAsmrFolder(p), false);
  }
});
