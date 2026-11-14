/**
 * 原生对话框桥接的「纯 Node」行为（v1.2.7 D）。
 *
 * 服务端既能在 Electron 主进程里跑，也能被 `pnpm start` / 单元测试直接跑。
 * 后者必须干净地退化为「没有原生对话框」，让调用方走 PowerShell 兜底，
 * 绝不能因为顶层 import 'electron' 把整个服务带崩。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeDialogAvailable, showNativeDialog } from '../server/desktop-dialog.mjs';

test('纯 Node：不声称自己有原生对话框', () => {
  assert.equal(process.versions.electron, undefined);
  assert.equal(nativeDialogAvailable(), false);
});

test('纯 Node：showNativeDialog 返回 null，由调用方兜底', async () => {
  assert.equal(await showNativeDialog({ properties: ['openDirectory'] }), null);
});

test('重复探测结论稳定（结果有缓存，不会来回变）', () => {
  assert.equal(nativeDialogAvailable(), false);
  assert.equal(nativeDialogAvailable(), false);
});
