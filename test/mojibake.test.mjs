/**
 * 疑似乱码检测 / 修复测试。
 *
 * 用 iconv-lite 生成真实的「UTF-8 字节被旧编码解码」样本，
 * 再确认修复器只修这些样本，不碰正常中文 / 日文 / 英文。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';

import { repairMojibake } from '../server/mojibake.mjs';

const mojibake = (text, encoding) => iconv.decode(Buffer.from(text, 'utf8'), encoding);

test('GBK 误解码的中文可修复', () => {
  const garbled = mojibake('你好', 'gbk');
  assert.equal(garbled, '浣犲ソ');
  assert.equal(repairMojibake(garbled)?.fixed, '你好');

  const september = mojibake('九月', 'gbk');
  assert.equal(repairMojibake(september)?.fixed, '九月');
});

test('Shift-JIS / CP932 误解码的日文可修复', () => {
  for (const text of ['こんにちは', 'ご主人様を好きすぎる']) {
    const garbled = mojibake(text, 'cp932');
    assert.equal(repairMojibake(garbled)?.fixed, text, garbled);
  }
});

test('Shift-JIS-as-Latin-1 带 C1 控制字符的曲目标题可修复', () => {
  const garbled = '09 \u0081~\u008f\u0084\u0096\u00da\u0081c\u0081c\u0081H';
  assert.equal(repairMojibake(garbled)?.fixed, '09 ×巡目……？');
});

test('Latin-1 误解码的中文 / 日文可修复', () => {
  for (const text of ['你好', '九月', '日本語', 'こんにちは']) {
    const garbled = mojibake(text, 'latin1');
    assert.equal(repairMojibake(garbled)?.fixed, text, JSON.stringify(garbled));
  }
});

test('正常文本不会被误修', () => {
  for (const text of [
    '你好', '九月', '日本語', 'こんにちは', 'ご主人様を好きすぎる',
    'Metal: Hellsinger OST', 'João', 'Café', 'ご唱和ください 我の名を！',
  ]) {
    assert.equal(repairMojibake(text), null, text);
  }
});

test('空值与超长文本直接跳过', () => {
  assert.equal(repairMojibake(''), null);
  assert.equal(repairMojibake('   '), null);
  assert.equal(repairMojibake('x'.repeat(501)), null);
});
