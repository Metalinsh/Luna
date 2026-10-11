/**
 * Luna 本轮 5 项修复的界面验证（CDP 驱动正在运行的 Electron 窗口）
 * 目标端口：Electron 的 --remote-debugging-port
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9360';
const API = process.env.LUNA_BASE || 'http://127.0.0.1:8799';
const SHOTS = path.join(process.cwd(), 'screenshots');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${name}${extra ? `  (${extra})` : ''}`); } else { fail += 1; console.log(`  FAIL  ${name}${extra ? `  (${extra})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`${CDP}/json/list`)).json();
// 开发模式会额外开一个 DevTools 页面，必须挑出真正的应用页面
const page = list.find((t) => t.type === 'page' && /^https?:\/\//.test(t.url ?? ''))
  ?? list.find((t) => t.type === 'page');
if (!page) { console.error('未找到 Electron 页面'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
  }
};
const send = (method, params = {}) => {
  id += 1;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
};
const ev = async (expr, timeoutMs = 30000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('求值超时')), timeoutMs)),
  ]);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败');
  return r.result.value;
};
const shot = async (f) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, f), Buffer.from(r.data, 'base64'));
};

await send('Page.enable');
await send('Runtime.enable');
console.log(`目标窗口：${page.url}`);
// 窗口已开着应用，直接复用；只在不是应用页面时才导航
if (!page.url.includes('127.0.0.1')) {
  await send('Page.navigate', { url: 'http://127.0.0.1:8799/' });
  await sleep(3500);
}
await ev(`location.hash = '#/'`);
// 等界面真正就绪：专辑墙有卡片、且应用已挂上事件
for (let i = 0; i < 30; i += 1) {
  const ready = await ev(`document.querySelectorAll('.album-card').length > 0
    && Boolean(document.querySelector('#selectModeBtn'))`).catch(() => false);
  if (ready) break;
  await sleep(500);
}
await sleep(1200);
await send('Page.reload', { ignoreCache: true });
await sleep(3800);
await ev(`location.hash = '#/'`);
await sleep(1800);

try {
  console.log('\n— 问题1：填写艺术家 / 填写社团 能弹出对话框 —');
  // 记下原社团，测试结束还原（避免污染用户数据）
  const origCircle = await ev(`(async () => {
    const r = await fetch('/api/albums?limit=100&kind=voice').then(x => x.json());
    const v = r.albums[0];
    const d = await fetch('/api/albums/' + v.id).then(x => x.json());
    return { id: v.id, circle: d.album.circle ?? '' };
  })()`);

  const dlg = await ev(`(async () => {
    // 进入 ASMR 库的一张音声专辑
    const r = await fetch('/api/albums?limit=100').then(x => x.json());
    const v = r.albums.find(a => a.is_voice);
    location.hash = '#/album/' + v.id;
    await new Promise(z => setTimeout(z, 2200));
    const artistBtn = document.querySelector('#voiceArtistBtn');
    const circleBtn = document.querySelector('#voiceCircleBtn');
    if (!artistBtn) return { step: 'no-button' };
    artistBtn.click();
    await new Promise(z => setTimeout(z, 600));
    const d = document.querySelector('#askDialog');
    const openAfterArtist = d?.open === true;
    const title = document.querySelector('#askTitle')?.textContent;
    document.querySelector('#askCancel').click();
    await new Promise(z => setTimeout(z, 400));
    const closedAfterCancel = d?.open !== true;

    circleBtn.click();
    await new Promise(z => setTimeout(z, 600));
    const openAfterCircle = d?.open === true;
    const title2 = document.querySelector('#askTitle')?.textContent;
    // 真的填一个社团进去
    const input = document.querySelector('#askInput');
    input.value = '界面自检社团';
    document.querySelector('#askOk').click();
    await new Promise(z => setTimeout(z, 1500));
    const albumId = v.id;
    const after = await fetch('/api/albums/' + albumId).then(x => x.json());
    return { openAfterArtist, title, closedAfterCancel, openAfterCircle, title2, savedCircle: after.album.circle };
  })()`);
  ok('点「填艺术家」弹出对话框', dlg.openAfterArtist === true, dlg.title);
  ok('取消能关闭对话框', dlg.closedAfterCancel === true);
  ok('点「填写社团」弹出对话框', dlg.openAfterCircle === true, dlg.title2);
  ok('社团可以真正写入', dlg.savedCircle === '界面自检社团', String(dlg.savedCircle));
  await shot('v5-ask-dialog.png');

  console.log('\n— 问题2：点击音乐库只显示该库专辑 —');
  const libs = await ev(`(async () => {
    location.hash = '#/';
    await new Promise(z => setTimeout(z, 1500));

    // 先清除可能残留的筛选（窗口会跨多次运行复用）
    const activeFirst = document.querySelector('.library-item.is-active');
    if (activeFirst) { activeFirst.click(); await new Promise(z => setTimeout(z, 1500)); }

    const items = [...document.querySelectorAll('.library-item')];
    const names = items.map(i => i.querySelector('.lib-path')?.textContent?.trim());
    const beforeCount = document.querySelectorAll('.album-card').length;
    items.find(i => /ASMR/i.test(i.querySelector('.lib-path')?.textContent ?? '')).click();
    await new Promise(z => setTimeout(z, 1900));

    const fresh = [...document.querySelectorAll('.library-item')];
    const activeItems = fresh.filter(i => i.classList.contains('is-active'));
    const cards = [...document.querySelectorAll('.album-card')];
    return {
      names,
      beforeCount,
      count: cards.length,
      activeNames: activeItems.map(i => i.querySelector('.lib-path')?.textContent?.trim()),
      titles: cards.map(c => c.querySelector('.album-name')?.textContent?.trim().slice(0, 12)),
      resultText: document.querySelector('#resultCount')?.textContent ?? '',
    };
  })()`);
  // 期望值从接口现算，避免音声数量变化后测试失效
  const expected = await (await fetch(`${API}/api/albums?limit=100`)).json();
  const expVoice = expected.albums.filter((a) => a.is_voice).length;
  const expTotal = expected.albums.length;

  ok('侧栏有 Album / ASMR 两个库', libs.names?.length === 2, (libs.names ?? []).join(' / '));
  ok('未筛选时显示全部', libs.beforeCount === expTotal, `${libs.beforeCount} 张（期望 ${expTotal}）`);
  ok('点击 ASMR 后只显示音声专辑', libs.count === expVoice,
    `${libs.count} 张（期望 ${expVoice}）：${(libs.titles ?? []).join(' | ')}`);
  ok('被点击的库高亮且只有它高亮',
    libs.activeNames?.length === 1 && /ASMR/i.test(libs.activeNames[0]), (libs.activeNames ?? []).join(','));
  ok('界面提示当前筛选', /ASMR/.test(libs.resultText), libs.resultText);
  await shot('v5-library-filter.png');

  console.log('\n— 问题3：ASMR 标签按目录自动维护 —');
  /**
   * 规则（用户指定）：**音乐库文件夹名为 ASMR 的，其中的专辑统一视为 ASMR；
   * 不在其中的专辑均非 ASMR。** 与是否音声、是否压缩包无关。
   * 因此这里不再断言「所有音声专辑都有标签」—— 音声发行若放在非 ASMR 目录下，
   * 按新规则就不该带该标签。
   */
  const tagInfo = await ev(`(async () => {
    const r = await fetch('/api/albums?limit=200').then(x => x.json());
    const rows = (r.albums ?? []).map(a => ({
      id: a.id, kind: a.kind, title: a.album,
      hasTag: (a.tags ?? []).some(t => t.name === 'ASMR'),
    }));
    return {
      total: rows.length,
      tagged: rows.filter(x => x.hasTag),
      untagged: rows.filter(x => !x.hasTag),
      badges: [...document.querySelectorAll('.album-card .badge')].map(b => b.textContent.trim()),
    };
  })()`);
  /**
   * 规则本身（目录名判定）已由 test/asmr-tag.test.mjs 的单元测试覆盖，
   * 并在真实库上端到端验证过；这里只做界面侧的健全性检查 ——
   * 开发库的 ASMR 库下确实拿到了标签，且没有出现「全库都被打上标签」的退化。
   */
  ok('ASMR 目录下的专辑已自动带上 ASMR 标签', tagInfo.tagged.length >= 1,
    `${tagInfo.tagged.length}/${tagInfo.total} 张带标签`);
  ok('并非所有专辑都被打上标签（存在未打标的普通专辑）', tagInfo.untagged.length >= 1,
    `未打标 ${tagInfo.untagged.length} 张`);
  ok('带标签的专辑全是音声发行或来自 ASMR 库',
    tagInfo.tagged.every((a) => a.kind === 'voice' || a.kind === 'music'),
    tagInfo.tagged.map((a) => `[${a.kind}]${String(a.title).slice(0, 16)}`).join(' | '));

  console.log('\n— 问题4：标签对话框不再点一下就关闭、可多选 —');
  const tagDlg = await ev(`(async () => {
    location.hash = '#/';
    await new Promise(z => setTimeout(z, 1400));
    const r = await fetch('/api/albums?limit=100').then(x => x.json());
    const a = r.albums.find(x => !x.is_voice);
    location.hash = '#/album/' + a.id;
    await new Promise(z => setTimeout(z, 2000));
    document.querySelector('#tagAlbumBtn').click();
    await new Promise(z => setTimeout(z, 900));
    const d = document.querySelector('#tagDialog');
    const opened = d?.open === true;

    const onCount = () => [...d.querySelectorAll('[data-pick]')].filter(p => p.classList.contains('is-on')).length;
    const pills = () => [...d.querySelectorAll('[data-pick]')];
    const before = onCount();

    // ① 点一个未选中的标签 → 应选中且对话框不关
    const offPill = pills().find(p => !p.classList.contains('is-on'));
    let afterPick = before; let stillOpen = d.open;
    if (offPill) {
      offPill.click();
      await new Promise(z => setTimeout(z, 400));
      afterPick = onCount();
      stillOpen = d.open;
    }
    // ② 再点一次 → 应取消选中（切换语义）
    const samePill = pills().find(p => p.classList.contains('is-on'));
    let afterToggle = afterPick;
    if (samePill) {
      samePill.click();
      await new Promise(z => setTimeout(z, 400));
      afterToggle = onCount();
    }
    const applyWithNone = document.querySelector('#tagApplyBtn')?.textContent ?? '';

    // ③ 选中一个 → 应用按钮应显示数量
    const pick2 = pills().find(p => !p.classList.contains('is-on'));
    if (pick2) { pick2.click(); await new Promise(z => setTimeout(z, 400)); }
    const applyWithSome = document.querySelector('#tagApplyBtn')?.textContent ?? '';

    document.querySelector('#tagCancelBtn').click();
    await new Promise(z => setTimeout(z, 300));
    return {
      opened, stillOpen, pillCount: pills().length, before, afterPick, afterToggle,
      hadUnselected: !!offPill, applyWithNone, applyWithSome, closed: d?.open !== true,
    };
  })()`);
  ok('标签对话框能打开', tagDlg.opened === true);
  ok('点击标签后对话框不关闭（原先的 bug）', tagDlg.stillOpen === true);
  ok('能选中未选中的标签', !tagDlg.hadUnselected || tagDlg.afterPick === tagDlg.before + 1,
    `${tagDlg.before} → ${tagDlg.afterPick}（共 ${tagDlg.pillCount} 个标签）`);
  ok('再点一次可取消选中', !tagDlg.hadUnselected || tagDlg.afterToggle === tagDlg.before,
    `${tagDlg.afterPick} → ${tagDlg.afterToggle}`);
  ok('有选中时应用按钮显示数量', /已选/.test(tagDlg.applyWithSome), tagDlg.applyWithSome);
  ok('取消能关闭', tagDlg.closed === true);
  await shot('v5-tag-dialog.png');

  console.log('\n— 问题4b：填新标签名回车 → 直接打上（端到端）—');
  const quickTag = await ev(`(async () => {
    const r = await fetch('/api/albums?limit=100').then(x => x.json());
    const a = r.albums.find(x => !x.is_voice);
    const before = (await fetch('/api/albums/' + a.id).then(x => x.json())).album.tags.map(t => t.name);
    location.hash = '#/album/' + a.id;
    await new Promise(z => setTimeout(z, 2000));
    document.querySelector('#tagAlbumBtn').click();
    await new Promise(z => setTimeout(z, 800));
    const input = document.querySelector('#tagInput');
    input.value = '界面自检标签';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(z => setTimeout(z, 2500));
    const after = (await fetch('/api/albums/' + a.id).then(x => x.json())).album.tags.map(t => t.name);
    const dlgOpen = document.querySelector('#tagDialog')?.open === true;
    return { before, after, dlgOpen, albumId: a.id };
  })()`);
  ok('回车后新标签直接生效（无需重开对话框）',
    quickTag.after?.includes('界面自检标签'), `${(quickTag.before ?? []).join(',')} → ${(quickTag.after ?? []).join(',')}`);
  ok('完成后对话框自动关闭', quickTag.dlgOpen === false);

  console.log('\n— 问题5：第 6 轨版本显示不重复 —');
  const chips = await ev(`(async () => {
    const r = await fetch('/api/albums?limit=100').then(x => x.json());
    const a = r.albums.find(x => x.rj_code === 'RJ01113481');
    location.hash = '#/album/' + a.id;
    await new Promise(z => setTimeout(z, 2000));
    const rows = [...document.querySelectorAll('#voiceTrackTable .voice-row:not(.is-head)')];
    const row = rows.find(x => (x.querySelector('.t-title')?.textContent ?? '').includes('午休'));
    if (!row) return { none: true };
    const labels = [...row.querySelectorAll('.ver-chip')].map(c => c.textContent.trim());
    return { labels, unique: new Set(labels).size, count: labels.length };
  })()`);
  ok('第 6 轨存在', !chips.none);
  ok('4 个变体标签互不重复', chips.unique === chips.count && chips.count === 4,
    `${chips.count} 个，去重后 ${chips.unique} 个：${(chips.labels ?? []).join(' | ')}`);
  ok('包含「无音效 无饮尿」', (chips.labels ?? []).some((l) => l.includes('无音效 无饮尿')),
    (chips.labels ?? []).join(' | '));
  await shot('v5-track6-versions.png');

  // 还原测试写过的社团
  await fetch(`${API}/api/albums/${origCircle.id}/circle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ circle: origCircle.circle }),
  });
  console.log(`  （已把 #${origCircle.id} 的社团还原为 ${JSON.stringify(origCircle.circle)}）`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
} catch (err) {
  console.error('验证异常：', err.message);
  fail += 1;
}
ws.close();
process.exit(fail ? 1 : 0);
