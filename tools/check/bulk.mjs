/**
 * 第 5 轮验证：选择按钮样式 + 批量填写艺术家/社团（仅 ASMR）
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9360';
const API = 'http://127.0.0.1:8799';
const SHOTS = 'E:\\Work\\本地专辑管理软件\\screenshots';

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass += 1; console.log(`  PASS  ${n}${e ? `  (${e})` : ''}`); } else { fail += 1; console.log(`  FAIL  ${n}${e ? `  (${e})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, o) => (await fetch(API + p, o)).json();
const post = (p, body) => j(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /^https?:\/\//.test(t.url ?? ''));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, x) => { ws.onopen = r; ws.onerror = x; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
  }
};
const send = (method, params = {}) => {
  id += 1;
  return new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });
};
const ev = async (expr, ms = 30000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('求值超时')), ms)),
  ]);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败');
  return r.result.value;
};
const shot = async (f) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, f), Buffer.from(r.data, 'base64'));
};

await send('Page.enable'); await send('Runtime.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(3600);
// hash 会跨测试残留（可能停在专辑详情页），先回到专辑墙
await ev(`location.hash = '#/'`);
await sleep(2000);

try {
  console.log('\n— 需求1：「选择」按钮有描边与主题底色 —');
  const style = await ev(`(() => {
    const b = document.querySelector('#selectModeBtn');
    const cs = getComputedStyle(b);
    return {
      border: cs.borderTopWidth + ' ' + cs.borderTopStyle,
      borderColor: cs.borderTopColor,
      bg: cs.backgroundColor,
      color: cs.color,
      text: b.textContent.trim(),
      visible: !b.hidden,
    };
  })()`);
  const hasBorder = parseFloat(style.border) > 0 && style.border.includes('solid');
  const bgNotTransparent = style.bg !== 'rgba(0, 0, 0, 0)' && style.bg !== 'transparent';
  ok('按钮有描边', hasBorder, style.border + ' ' + style.borderColor);
  ok('按钮有主题色底色（非透明）', bgNotTransparent, style.bg);
  ok('按钮可见且文案为「选择」', style.visible === true && style.text === '选择', style.text);

  console.log('\n— 需求1b：进入多选后按钮呈激活态 —');
  const active = await ev(`(async () => {
    document.querySelector('#selectModeBtn').click();
    await new Promise(z => setTimeout(z, 500));
    const b = document.querySelector('#selectModeBtn');
    const cs = getComputedStyle(b);
    return { isActive: b.classList.contains('is-active'), text: b.textContent.trim(), bg: cs.backgroundColor, bulkVisible: !document.querySelector('#bulkBar').hidden };
  })()`);
  ok('进入多选后按钮高亮', active.isActive === true && active.text === '退出多选', active.text);
  ok('批量操作条出现', active.bulkVisible === true);
  await shot('v9-select-button.png');

  console.log('\n— 需求2：批量填写（仅 ASMR 生效）—');
  const voice = (await j('/api/albums?limit=100&kind=voice')).albums;
  const music = (await j('/api/albums?limit=100&kind=music')).albums;

  // 记下原值，测试结束按原样还原（不要误删用户已填的社团）
  const originalCircles = {};
  for (const a of voice) {
    const d = await j(`/api/albums/${a.id}`);
    originalCircles[a.id] = d.album.circle ?? '';
  }

  // 通过点击卡片来选中（state 是模块内变量，测试只能走真实交互）
  const selectCards = (ids) => ev(`(async () => {
    const ids = ${JSON.stringify(ids)};
    document.querySelector('#bulkClearBtn')?.click();
    await new Promise(z => setTimeout(z, 300));
    for (const id of ids) {
      const card = document.querySelector('.album-card[data-id="' + id + '"]');
      if (card) card.click();
      await new Promise(z => setTimeout(z, 120));
    }
    return {
      count: document.querySelector('#bulkCount')?.textContent?.trim() ?? '',
      artistHidden: document.querySelector('#bulkArtistBtn').hidden,
      circleHidden: document.querySelector('#bulkCircleBtn').hidden,
      hint: document.querySelector('#bulkVoiceHint')?.textContent?.trim() ?? '',
    };
  })()`);

  const mixed = await selectCards([voice[0].id, voice[1].id, music[0].id]);
  ok('选中含音声时出现「批量填艺术家」「批量填社团」',
    mixed.artistHidden === false && mixed.circleHidden === false,
    `${mixed.count} · ${mixed.hint}`);
  ok('提示说明只对 ASMR 生效并报告跳过数',
    /ASMR/.test(mixed.hint) && /跳过/.test(mixed.hint), mixed.hint);
  await shot('v9-bulk-voice.png');

  console.log('\n— 需求2b：接口只改音声、跳过普通专辑 —');
  const circleVal = '批检社团';
  const ids = [voice[0].id, voice[1].id, music[0].id];
  const res = await post('/api/albums/bulk-voice-meta', { ids, circle: circleVal });
  ok('接口报告更新张数', res.updated === 2, `updated=${res.updated}`);
  ok('普通专辑被跳过', (res.skipped ?? []).length === 1, (res.skipped ?? []).join(','));
  ok('未写回文件', res.wrote_files === false);

  const v0 = await j(`/api/albums/${voice[0].id}`);
  const v1 = await j(`/api/albums/${voice[1].id}`);
  const m0 = await j(`/api/albums/${music[0].id}`);
  ok('音声专辑 A 已写入', v0.album.circle === circleVal, String(v0.album.circle));
  ok('音声专辑 B 已写入', v1.album.circle === circleVal, String(v1.album.circle));
  ok('普通专辑未被修改', m0.album.circle !== circleVal, `circle=${JSON.stringify(m0.album.circle)}`);

  console.log('\n— 需求2c：全选普通专辑时不显示该功能 —');
  const noVoice = await selectCards(music.map((a) => a.id));
  ok('选中的全是普通专辑 → 按钮隐藏',
    noVoice.artistHidden === true && noVoice.circleHidden === true,
    `${noVoice.count} · hint隐藏`);
  const rejected = await post('/api/albums/bulk-voice-meta', { ids: music.map((a) => a.id), circle: '不该生效' });
  ok('接口层同样拒绝（updated=0）', rejected.updated === 0, rejected.note ?? '');
  const m0again = await j(`/api/albums/${music[0].id}`);
  ok('普通专辑仍未被改动', m0again.album.circle !== '不该生效');

  console.log('\n— 需求2d：界面走一遍完整流程 —');
  await selectCards([voice[0].id]);
  const flow = await ev(`(async () => {
    document.querySelector('#bulkCircleBtn').click();
    await new Promise(z => setTimeout(z, 800));
    const dlg = document.querySelector('#askDialog');
    const opened = dlg?.open === true;
    const title = document.querySelector('#askTitle')?.textContent ?? '';
    const hint = document.querySelector('#askHint')?.textContent ?? '';
    document.querySelector('#askInput').value = '界面批检社团';
    document.querySelector('#askOk').click();
    await new Promise(z => setTimeout(z, 2800));
    return { opened, title, hint, dialogClosed: dlg?.open !== true };
  })()`);
  ok('点击后弹出输入框', flow.opened === true, flow.title);
  ok('输入框说明仅记库内、普通专辑跳过', /不会写回/.test(flow.hint) && /跳过/.test(flow.hint), flow.hint);
  ok('确定后对话框关闭', flow.dialogClosed === true);
  const saved = await j(`/api/albums/${voice[0].id}`);
  ok('界面流程真正写入成功', saved.album.circle === '界面批检社团', String(saved.album.circle));
  await ev(`document.querySelector('#bulkExitBtn')?.click(); true`);

  // 还原为测试前的值（逐张精确还原，避免误删用户数据）
  for (const [albumId, circle] of Object.entries(originalCircles)) {
    await post(`/api/albums/${albumId}/circle`, { circle });
  }
  console.log('  （已按原值还原社团）');

  /*
   * 需求3：从库中移除（多选）。
   * 只验证「入口、样式、确认文案、设置里的恢复入口」，**不真的执行移除** ——
   * 移除会改动用户索引，验证脚本不该碰。数据层由 test/albums-tags.test.mjs 覆盖。
   */
  console.log('\n— 需求3：多选「从库中移除」（只验证入口与文案，不执行移除）—');
  const all = (await j('/api/albums?limit=100')).albums;
  await selectCards([all[0].id, all[1].id]);

  const removeUi = await ev(`(() => {
    const b = document.querySelector('#bulkRemoveBtn');
    const cs = getComputedStyle(b);
    return {
      exists: !!b,
      text: b?.textContent?.trim() ?? '',
      title: b?.getAttribute('title') ?? '',
      hidden: b?.hidden === true,
      danger: b?.classList.contains('btn-danger') === true,
      color: cs.color,
      count: document.querySelector('#bulkCount')?.textContent?.trim() ?? '',
    };
  })()`);
  ok('批量条里有「从库中移除」按钮', removeUi.exists && removeUi.text === '从库中移除', removeUi.text);
  ok('按钮在选中专辑后可见', removeUi.hidden === false, removeUi.count);
  ok('按钮用危险色样式（区分于普通操作）', removeUi.danger === true, removeUi.color);
  ok('悬浮说明写清「不删除本地文件 + 扫描会忽略」',
    /不删除/.test(removeUi.title) && /忽略/.test(removeUi.title), removeUi.title);
  await shot('v13-bulk-remove.png');

  const confirmUi = await ev(`(async () => {
    document.querySelector('#bulkRemoveBtn').click();
    await new Promise(z => setTimeout(z, 700));
    const dlg = document.querySelector('#confirmDialog');
    const out = {
      opened: dlg?.open === true,
      title: document.querySelector('#confirmTitle')?.textContent ?? '',
      text: document.querySelector('#confirmText')?.textContent ?? '',
      okLabel: document.querySelector('#confirmOk')?.textContent ?? '',
      okDanger: document.querySelector('#confirmOk')?.classList.contains('btn-danger') === true,
    };
    // 取消，绝不真的移除
    document.querySelector('#confirmCancel').click();
    await new Promise(z => setTimeout(z, 400));
    out.cancelled = dlg?.open !== true;
    return out;
  })()`);
  ok('点按钮弹出确认框', confirmUi.opened === true, confirmUi.title);
  ok('确认框写明不删除本地文件', /不会删除或修改任何本地文件/.test(confirmUi.text));
  ok('确认框写明后续扫描会忽略、可在设置恢复',
    /自动忽略/.test(confirmUi.text) && /已移除的专辑/.test(confirmUi.text));
  ok('确认按钮是危险色且文案明确', confirmUi.okDanger === true && confirmUi.okLabel === '从库中移除', confirmUi.okLabel);
  ok('取消后对话框关闭（未执行移除）', confirmUi.cancelled === true);
  const stillThere = (await j('/api/albums?limit=100')).albums.length;
  ok('取消后专辑数量未变化', stillThere === all.length, `${all.length} → ${stillThere}`);

  console.log('\n— 需求3b：设置里有「已移除的专辑」恢复入口 —');
  const exApi = await j('/api/exclusions');
  ok('排除清单接口可用', Array.isArray(exApi.exclusions) && typeof exApi.total === 'number', `total=${exApi.total}`);
  const setSec = await ev(`(async () => {
    document.querySelector('#bulkExitBtn')?.click();
    document.querySelector('#settingsBtn').click();
    await new Promise(z => setTimeout(z, 1800));
    const secs = [...document.querySelectorAll('#settingsBody .set-sec')];
    const sec = secs.find(s => /已移除的专辑/.test(s.querySelector('h4')?.textContent ?? ''));
    const txt = sec?.textContent ?? '';
    document.querySelector('#settingsCloseBtn')?.click();
    await new Promise(z => setTimeout(z, 300));
    return {
      hasSection: !!sec,
      sections: secs.map(s => s.querySelector('h4')?.textContent?.trim() ?? ''),
      mentionsFiles: /不碰本地文件/.test(txt) || /不会删除/.test(txt) || /只删索引/.test(txt),
    };
  })()`);
  ok('设置面板新增「已移除的专辑」分段', setSec.hasSection === true, setSec.sections.join(' / '));
  ok('分段文案说明只删索引、不碰本地文件', setSec.mentionsFiles === true);
} catch (err) {
  console.error('验证异常：', err.message);
  fail += 1;
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close();
process.exit(fail ? 1 : 0);
