/**
 * 播放器快捷键配置（v1.2.9）：默认值、格式校验、冲突回退。
 * 用独立临时数据目录，不触碰用户 config.json。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-keys-'));
process.env.LAM_DATA_DIR = dataDir;

let config;

before(async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  config = await import('../server/config.mjs');
});

const DEFAULTS = {
  playPause: 'Space',
  seekBackward: 'ArrowLeft',
  seekForward: 'ArrowRight',
  volumeDown: 'ArrowDown',
  volumeUp: 'ArrowUp',
  prevTrack: 'Ctrl+Alt+ArrowLeft',
  nextTrack: 'Ctrl+Alt+ArrowRight',
  back: 'Alt+ArrowLeft',
};

test('默认键位就是当前实现的那一套', () => {
  assert.deepEqual(config.readConfig().shortcuts, DEFAULTS);
});

test('normalizeShortcut：修饰键顺序统一、非法输入返回 null', () => {
  assert.equal(config.normalizeShortcut('Alt+Ctrl+KeyP'), 'Ctrl+Alt+KeyP');
  assert.equal(config.normalizeShortcut('Shift+Space'), 'Shift+Space');
  assert.equal(config.normalizeShortcut(' Space '), 'Space');
  assert.equal(config.normalizeShortcut(''), null);
  assert.equal(config.normalizeShortcut('Ctrl+Ctrl+KeyP'), null);
  assert.equal(config.normalizeShortcut('Hyper+KeyP'), null);
  assert.equal(config.normalizeShortcut('Ctrl+'), null);
  assert.equal(config.normalizeShortcut('ArrowLeft+Ctrl'), null);   // 主键必须在最后
});

test('合法键位会保存，且按规范顺序写回', () => {
  config.writeConfig({ shortcuts: { playPause: 'Alt+Ctrl+KeyP' } });
  const cfg = config.readConfig();
  assert.equal(cfg.shortcuts.playPause, 'Ctrl+Alt+KeyP');
  // 没改的动作保持默认
  assert.equal(cfg.shortcuts.seekForward, 'ArrowRight');
});

test('非法值回退默认，未知动作被丢弃', () => {
  config.writeConfig({ shortcuts: { seekForward: 'Ctrl+Ctrl+ArrowRight', hack: 'KeyH' } });
  const cfg = config.readConfig();
  assert.equal(cfg.shortcuts.seekForward, 'ArrowRight');
  assert.equal('hack' in cfg.shortcuts, false);
});

test('与前面的动作撞键时，后一个回退自己的默认值', () => {
  config.writeConfig({ shortcuts: DEFAULTS });
  // nextTrack 抢 playPause 默认的 Space → 应回退到 Ctrl+Alt+ArrowRight
  config.writeConfig({ shortcuts: { nextTrack: 'Space' } });
  const cfg = config.readConfig();
  assert.equal(cfg.shortcuts.nextTrack, 'Ctrl+Alt+ArrowRight');
  assert.equal(cfg.shortcuts.playPause, 'Space');
});
