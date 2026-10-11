/**
 * 第 4 轮微调验证（驱动 Electron 开发实例）
 *  1) 艺术家以 artist 为准；提示有「采用它」「保持现状」；任一选择后提示消失
 *  2) 详情页格式：艺术家：X   社团：Y
 *  3) 列宽拖动方向与拖动一致
 *  4) 新增「顺序播放」：最后一首播完停止
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

try {
  // 找 RJ01002989 作为「有分歧」的样本，并把状态重置为「待选择」，保证可重复
  const voice = (await j('/api/albums?limit=100&kind=voice')).albums;
  const target = voice.find((a) => a.rj_code === 'RJ01002989');
  ok('存在测试样本 RJ01002989', Boolean(target), target?.rj_code);

  const { DatabaseSync } = await import('node:sqlite');
  const dbFile = 'E:\\Work\\本地专辑管理软件\\data\\library.db';
  const resetState = () => {
    const d = new DatabaseSync(dbFile);
    d.prepare(`UPDATE albums SET album_artist = '逢坂成美', album_artist_source = 'tag',
      artist_suggested = 'plug in.東京', artist_decision = NULL WHERE id = ?`).run(target.id);
    d.close();
  };
  resetState();
  await ev(`location.reload()`).catch(() => {});
  await sleep(3600);

  console.log('\n— 需求1：艺术家以 artist 为准 —');
  const info = await j(`/api/albums/${target.id}`);
  ok('专辑艺术家取自 artist 标签', info.album.album_artist === '逢坂成美', String(info.album.album_artist));
  ok('albumartist 作为建议保留', info.album.artist_suggested === 'plug in.東京', String(info.album.artist_suggested));

  const promptUi = await ev(`(async () => {
    location.hash = '#/album/${target.id}';
    await new Promise(z => setTimeout(z, 2200));
    const warn = document.querySelector('.src-warn');
    return {
      hasWarn: Boolean(warn),
      text: warn?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 80) ?? '',
      buttons: [...(warn?.querySelectorAll('button') ?? [])].map(b => b.textContent.trim()),
    };
  })()`);
  ok('出现提示', promptUi.hasWarn === true, promptUi.text);
  ok('提示同时提供「采用它」和「保持现状」',
    promptUi.buttons.includes('采用它') && promptUi.buttons.includes('保持现状'),
    promptUi.buttons.join(' / '));
  await shot('v8-artist-prompt.png');

  console.log('\n— 需求1b：选择「保持现状」→ 提示消失且艺术家不变 —');
  const keep = await ev(`(async () => {
    document.querySelector('#keepArtistBtn').click();
    await new Promise(z => setTimeout(z, 2200));
    return {
      warnGone: !document.querySelector('.src-warn'),
      artistLine: document.querySelector('.detail-artist')?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 60) ?? '',
    };
  })()`);
  const afterKeep = await j(`/api/albums/${target.id}`);
  ok('提示消失', keep.warnGone === true);
  ok('艺术家保持不变（仍为 artist 值）', afterKeep.album.album_artist === '逢坂成美', String(afterKeep.album.album_artist));
  ok('建议值已清空（不再重复询问）', afterKeep.album.artist_suggested === null, String(afterKeep.album.artist_suggested));
  ok('已记录决定=kept', afterKeep.album.artist_decision === 'kept', String(afterKeep.album.artist_decision));

  // 重新扫描后不应再次提示
  await post('/api/scan', { libraryIds: [] });
  for (let i = 0; i < 60; i += 1) {
    await sleep(2000);
    const s = (await j('/api/scan/status')).state;
    if (!s.running) break;
  }
  const afterRescan = await j(`/api/albums/${target.id}`);
  ok('重新扫描后不再重复提示',
    afterRescan.album.artist_suggested === null && afterRescan.album.album_artist === '逢坂成美',
    `建议=${JSON.stringify(afterRescan.album.artist_suggested)} 艺术家=${afterRescan.album.album_artist}`);

  console.log('\n— 需求1c：采用它 → 只改显示、不动文件 —');
  // 准备一条建议（模拟用户尚未做过选择的状态）
  resetState();
  const db = new DatabaseSync(dbFile);
  const trackBefore = db.prepare(`SELECT id, path, mtime, size FROM tracks
    WHERE album_id = ? ORDER BY id LIMIT 1`).get(target.id);
  db.close();

  const adopt = await ev(`(async () => {
    // hash 不变不会触发路由，先跳走再回来，强制按新数据重渲染
    location.hash = '#/';
    await new Promise(z => setTimeout(z, 900));
    location.hash = '#/album/${target.id}';
    await new Promise(z => setTimeout(z, 2200));
    const warnBefore = Boolean(document.querySelector('.src-warn'));
    const btn = document.querySelector('#adoptArtistBtn');
    if (!btn) return { warnBefore, missing: true };
    btn.click();
    await new Promise(z => setTimeout(z, 2600));
    return {
      warnBefore,
      warnGone: !document.querySelector('.src-warn'),
      artistLine: document.querySelector('.detail-artist')?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 40) ?? '',
    };
  })()`);
  if (adopt.missing) throw new Error('采用按钮未渲染出来');
  const afterAdopt = await j(`/api/albums/${target.id}`);
  const db2 = new DatabaseSync(dbFile);
  const trackAfter = db2.prepare(`SELECT id, path, mtime, size FROM tracks WHERE id = ?`).get(trackBefore.id);
  db2.close();

  ok('采用前提示存在', adopt.warnBefore === true);
  ok('采用后艺术家改为标签值', afterAdopt.album.album_artist === 'plug in.東京', String(afterAdopt.album.album_artist));
  ok('采用后提示消失', adopt.warnGone === true && afterAdopt.album.artist_suggested === null);
  ok('记录了决定=adopted', afterAdopt.album.artist_decision === 'adopted', String(afterAdopt.album.artist_decision));
  ok('界面显示已更新', /plug in/.test(adopt.artistLine), adopt.artistLine);
  ok('音频文件未被改动（mtime/size 不变）',
    trackAfter.mtime === trackBefore.mtime && trackAfter.size === trackBefore.size,
    `${trackBefore.mtime} / ${trackBefore.size}B`);

  // 复原成「未做选择」的状态，交给你在界面上自己决定
  const db3 = new DatabaseSync(dbFile);
  db3.prepare(`UPDATE albums SET album_artist = '逢坂成美', album_artist_source = 'tag',
    artist_suggested = 'plug in.東京', artist_decision = NULL WHERE id = ?`).run(target.id);
  db3.close();
  console.log('  （已复原为「待你选择」状态）');

  console.log('\n— 需求2：详情页「艺术家：X   社团：Y」 —');
  const fmt = await ev(`(async () => {
    location.hash = '#/';
    await new Promise(z => setTimeout(z, 800));
    location.hash = '#/album/${target.id}';
    await new Promise(z => setTimeout(z, 2200));
    const el = document.querySelector('.detail-artist');
    return { text: el?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 80) ?? '' };
  })()`);
  ok('格式为「艺术家：X 社团：Y」', /^艺术家：/.test(fmt.text) && /社团：/.test(fmt.text), fmt.text);
  const afterRestore = await j(`/api/albums/${target.id}`);
  ok('已复原为「待你选择」状态',
    afterRestore.album.album_artist === '逢坂成美' && afterRestore.album.artist_suggested === 'plug in.東京'
      && afterRestore.album.artist_decision === null,
    `艺术家=${afterRestore.album.album_artist} 建议=${afterRestore.album.artist_suggested} 决定=${afterRestore.album.artist_decision}`);

  // 列宽拖动方向 → 由 check/detail.mjs 负责
  // 顺序播放 → 由 check/player.mjs 负责

  console.log('\n— 需求3：手工填社团 / 艺术家 → 自动建立同名标签 —');
  const voiceAll = (await j('/api/albums?limit=100&kind=voice')).albums;
  const teamA = voiceAll.find((a) => a.rj_code === 'RJ01128508');
  const teamB = voiceAll.find((a) => a.rj_code === 'RJ01002989');
  if (!teamA || !teamB) throw new Error('缺少「上海飯店」测试样本');

  // 先清空两者社团，再只给 A 填一次 —— B 靠文件夹名自动套用
  await post(`/api/albums/${teamA.id}/circle`, { circle: '' });
  await post(`/api/albums/${teamB.id}/circle`, { circle: '' });
  const linkRes = await post(`/api/albums/${teamA.id}/circle`, { circle: '上海飯店' });
  ok('填写社团返回自动建立的同名标签', linkRes.tag?.name === '上海飯店', JSON.stringify(linkRes.tag));
  ok('本次填写的作品被打上同名标签',
    ((await j(`/api/albums/${teamA.id}`)).album.tags ?? []).some((t) => t.name === '上海飯店'));
  ok('被自动套用的作品同样打上同名标签',
    ((await j(`/api/albums/${teamB.id}`)).album.tags ?? []).some((t) => t.name === '上海飯店'));
  await shot('v10-circle-tag.png');

  const artTagRes = await post(`/api/albums/${teamA.id}/voice-artist`, { artist: '小花衣こっこ' });
  ok('填写艺术家同样建立同名标签', artTagRes.tag?.name === '小花衣こっこ', JSON.stringify(artTagRes.tag));
  ok('艺术家标签已打到该作品',
    ((await j(`/api/albums/${teamA.id}`)).album.tags ?? []).some((t) => t.name === '小花衣こっこ'));
  await shot('v10-artist-tag.png');
} catch (err) {
  console.error('验证异常：', err.message);
  fail += 1;
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close();
process.exit(fail ? 1 : 0);
