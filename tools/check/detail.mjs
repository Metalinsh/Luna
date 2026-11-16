/**
 * 本轮 4 项界面/数据微调验证（驱动 Electron 开发实例）
 *  1) 详情页曲目行：右侧 3 个按钮常亮、右对齐、不与文字重叠；标题/艺术家/时长列可拖动
 *  2) 播放改为双击曲目名称（版本按钮仍单击播放）
 *  3) 错误的标签艺术家不再被采用，降级为「待确认建议」
 *  4) 多艺术家专辑显示完整艺术家
 */
import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9360';
const SHOTS = path.join(process.cwd(), 'screenshots');

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass += 1; console.log(`  PASS  ${n}${e ? `  (${e})` : ''}`); } else { fail += 1; console.log(`  FAIL  ${n}${e ? `  (${e})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /^https?:\/\//.test(t.url ?? ''));
if (!page) { console.error('未找到应用页面'); process.exit(1); }
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
/** 鼠标拖拽（Pointer Events 由鼠标事件合成，和真实拖动走同一条路径） */
const mouseAt = async (type, x, y) => {
  await send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
  });
};
/** 把第 from 行拖到第 to 行附近（frac 0.75 = 落在该行下半部） */
const dragRow = async (tableSel, from, to, frac = 0.75) => {
  const geo = await ev(`(() => {
    const rows = [...document.querySelectorAll('${tableSel} .track-row:not(.is-head)')];
    const h = rows[${from}].querySelector('.drag-handle').getBoundingClientRect();
    const t = rows[${to}].getBoundingClientRect();
    return { hx: h.x + h.width / 2, hy: h.y + h.height / 2, ty: t.top + t.height * ${frac} };
  })()`);
  await mouseAt('mouseMoved', geo.hx, geo.hy);
  await mouseAt('mousePressed', geo.hx, geo.hy);
  await sleep(120);
  await mouseAt('mouseMoved', geo.hx, (geo.hy + geo.ty) / 2);
  await sleep(120);
  await mouseAt('mouseMoved', geo.hx, geo.ty);
  await sleep(150);
  await mouseAt('mouseReleased', geo.hx, geo.ty);
};
const rowTitles = (sel) => ev(`[...document.querySelectorAll('${sel} .track-row:not(.is-head) .t-title span')].map(e => e.textContent.trim())`);

await send('Page.enable'); await send('Runtime.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(3600);

try {
  console.log('\n— 需求1：详情页曲目行布局 —');
  const layout = await ev(`(async () => {
    const r = await fetch('/api/albums?limit=100&kind=music').then(x => x.json());
    const a = r.albums[0];
    location.hash = '#/album/' + a.id;
    await new Promise(z => setTimeout(z, 2200));
    const row = document.querySelector('#albumDetail .track-row:not(.is-head)');
    if (!row) return { none: true };
    const actions = row.querySelector('.t-actions');
    const btns = [...actions.querySelectorAll('button')];
    const title = row.querySelector('.t-title');
    const time = row.querySelector('.t-time');
    const cs = getComputedStyle(actions);
    const rr = row.getBoundingClientRect();
    const ar = actions.getBoundingClientRect();
    const tr = title.getBoundingClientRect();
    return {
      btnCount: btns.length,
      opacity: cs.opacity,
      actionsRight: Math.round(rr.right - ar.right),
      titleVsActions: Math.round(ar.left - tr.right),
      timeVsActions: Math.round(ar.left - time.getBoundingClientRect().right),
      grips: row.closest('.track-table')?.querySelectorAll('.col-grip').length ?? 0,
      headerGrips: document.querySelectorAll('#albumDetail .col-grip').length,
      rowPaddingRight: getComputedStyle(row).paddingRight,
    };
  })()`);
  ok('曲目行右侧有 3 个操作按钮', layout.btnCount === 3, `${layout.btnCount} 个`);
  ok('按钮常亮（opacity=1）', layout.opacity === '1', `opacity=${layout.opacity}`);
  ok('按钮右端对齐', Math.abs(layout.actionsRight) <= 14, `距右边缘 ${layout.actionsRight}px`);
  ok('标题不与按钮重叠', layout.titleVsActions > 0, `间隔 ${layout.titleVsActions}px`);
  ok('时长不与按钮重叠', layout.timeVsActions > 0, `间隔 ${layout.timeVsActions}px`);
  ok('表头有列宽拖动手柄', layout.headerGrips >= 2, `${layout.headerGrips} 个`);

  console.log('\n— 需求1b：拖动列宽 —');
  const drag = await ev(`(async () => {
    const grip = document.querySelector('#albumDetail .col-grip[data-grip="artist"]');
    if (!grip) return { none: true };
    const table = document.querySelector('#albumDetail .track-table');
    const before = getComputedStyle(table).getPropertyValue('--w-artist').trim();
    const gr = grip.getBoundingClientRect();
    const cx = gr.left + gr.width / 2, cy = gr.top + gr.height / 2;
    const opts = { bubbles: true, clientX: cx, clientY: cy, pointerId: 1, isPrimary: true, button: 0 };
    grip.dispatchEvent(new PointerEvent('pointerdown', opts));
    document.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: cx + 60 }));
    document.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: cx + 60 }));
    await new Promise(z => setTimeout(z, 300));
    const after = getComputedStyle(table).getPropertyValue('--w-artist').trim();
    const saved = JSON.parse(localStorage.getItem('trackColWidths') ?? '{}');
    // 恢复默认，避免影响后续
    document.querySelector('#albumDetail .col-grip[data-grip="artist"]');
    return { before, after, savedArtist: saved.artist };
  })()`);
  const beforeN = parseInt(drag.before, 10);
  const afterN = parseInt(drag.after, 10);
  // 手柄在「标题」列右缘：向右拖 → 标题变宽、艺术家列变窄
  ok('拖动后艺术家列宽发生变化（方向与拖动一致）',
    Number.isFinite(beforeN) && Number.isFinite(afterN) && afterN < beforeN,
    `向右拖 ${drag.before} → ${drag.after}`);
  ok('列宽已持久化到本地', Number.isFinite(drag.savedArtist), `saved=${drag.savedArtist}`);
  await ev(`localStorage.removeItem('trackColWidths'); location.reload(); true`);
  await sleep(3600);

  console.log('\n— 需求2：双击名称播放，单击不播放 —');
  const play = await ev(`(async () => {
    const r = await fetch('/api/albums?limit=100&kind=music').then(x => x.json());
    location.hash = '#/album/' + r.albums[0].id;
    await new Promise(z => setTimeout(z, 2200));
    const row = document.querySelector('#albumDetail .track-row:not(.is-head)');
    const title = row.querySelector('.t-title');
    const before = document.querySelector('audio')?.currentSrc ?? null;

    title.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(z => setTimeout(z, 700));
    const afterSingle = document.querySelector('audio')?.currentSrc ?? null;

    title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(z => setTimeout(z, 1400));
    const afterDouble = document.querySelector('audio')?.currentSrc ?? null;
    return { before, afterSingle, afterDouble };
  })()`);
  ok('单击曲目名不触发播放', play.afterSingle === play.before,
    `单击前后 src ${play.before === play.afterSingle ? '一致' : '被改变'}`);
  ok('双击曲目名触发播放', Boolean(play.afterDouble) && play.afterDouble !== play.before,
    String(play.afterDouble ?? '').split('/').pop());
  await shot('v7-track-row.png');

  console.log('\n— 需求3：多艺术家专辑显示完整 —');
  const multi = await ev(`(async () => {
    const r = await fetch('/api/albums?limit=100').then(x => x.json());
    const a = r.albums.find(x => /One by One/.test(x.album));
    /*
     * 专辑墙按音乐库过滤（v1.2.4）：先切到该专辑所属类别的库，
     * 否则卡片根本不在墙上（墙上只有当前库的专辑）。
     */
    const libs = await fetch('/api/libraries').then(x => x.json());
    const lib = libs.libraries.find(l => l.kind === (a.is_voice ? 'voice' : 'music')) ?? libs.libraries[0];
    location.hash = '#/';
    await new Promise(z => setTimeout(z, 1400));
    document.querySelector('.library-item[data-id="' + lib.id + '"]')?.click();
    await new Promise(z => setTimeout(z, 2200));
    const cards = [...document.querySelectorAll('.album-card')];
    const card = cards.find(c => (c.querySelector('.album-name')?.textContent ?? '').includes('One by One'));
    const d = await fetch('/api/albums/' + a.id).then(x => x.json());
    return {
      apiArtist: a.album_artist,
      detailArtist: d.album.album_artist,
      cardCredit: card?.querySelector('.album-credit')?.textContent?.trim() ?? '',
    };
  })()`);
  ok('接口返回完整艺术家', /KOTONOHOUSE/.test(multi.apiArtist) && /Neko Hacker/.test(multi.apiArtist),
    multi.apiArtist);
  ok('详情页与列表口径一致', multi.detailArtist === multi.apiArtist, multi.detailArtist);
  ok('专辑墙也显示完整艺术家',
    /KOTONOHOUSE/.test(multi.cardCredit) && /Neko Hacker/.test(multi.cardCredit), multi.cardCredit);
  await shot('v7-multi-artist.png');

  console.log('\n— 需求5：拖动调整播放顺序（v13） —');
  const musicOrder = await ev(`(async () => {
    const r = await fetch('/api/albums?limit=200&kind=music').then(x => x.json());
    for (const a of r.albums) {
      const d = await fetch('/api/albums/' + a.id).then(x => x.json());
      const list = d.tracks ?? [];
      if (list.length >= 3 && list.every(t => (t.source_kind ?? 'file') === 'file')) {
        location.hash = '#/album/' + a.id;
        await new Promise(z => setTimeout(z, 2400));
        return { id: a.id, titles: list.map(t => t.title) };
      }
    }
    return null;
  })()`);
  if (!musicOrder) {
    ok('找到可拖动排序的普通专辑', false, '库里没有 3 首以上本地曲目');
  } else {
    const ui = await ev(`({
      handles: document.querySelectorAll('#albumDetail .drag-handle').length,
      rows: document.querySelectorAll('#albumDetail .track-row:not(.is-head)').length,
      bar: Boolean(document.querySelector('.track-order-bar')),
    })`);
    ok('每个曲目行都有拖动手柄，初始没有「自定义顺序」提示条',
      ui.handles === ui.rows && ui.rows === musicOrder.titles.length && ui.bar === false,
      `${ui.handles}/${ui.rows} 个手柄 · bar=${ui.bar}`);

    await dragRow('#albumDetail .track-table', 0, 2);
    await sleep(1800);
    const moved = await ev(`(async () => {
      const d = await fetch('/api/albums/${musicOrder.id}').then(x => x.json());
      const dom = [...document.querySelectorAll('#albumDetail .track-row:not(.is-head) .t-title span')].map(e => e.textContent.trim());
      return {
        dom,
        api: (d.tracks ?? []).map(t => t.title),
        custom: d.album.custom_order,
        bar: Boolean(document.querySelector('.track-order-bar')),
        nums: [...document.querySelectorAll('#albumDetail .t-num-val')].slice(0, 3).map(e => e.textContent.trim()),
      };
    })()`);
    ok('拖动后 DOM 顺序变化（第 1 行落到第 3 行前）',
      moved.dom[0] === musicOrder.titles[1] && moved.dom[2] === musicOrder.titles[0],
      moved.dom.slice(0, 3).join(' | '));
    ok('新顺序已写入接口，且 album.custom_order=true',
      JSON.stringify(moved.dom) === JSON.stringify(moved.api) && moved.custom === true,
      `custom=${moved.custom}`);
    ok('行号改为播放位次（1,2,3…）', moved.nums.join(',') === '1,2,3', moved.nums.join(','));
    ok('出现「已自定义播放顺序」提示条', moved.bar === true);

    await ev(`document.querySelector('#playAlbumBtn')?.click()`);
    await sleep(1200);
    const nowPlaying = await ev(`document.querySelector('#npTitle')?.textContent?.trim() ?? ''`);
    ok('播放专辑从新的第一首开始（队列跟着新顺序）', nowPlaying === moved.dom[0],
      `${nowPlaying} vs ${moved.dom[0]}`);
    await ev(`document.querySelector('audio')?.pause(); true`);

    await ev(`(async () => {
      location.hash = '#/';
      await new Promise(z => setTimeout(z, 900));
      location.hash = '#/album/${musicOrder.id}';
      await new Promise(z => setTimeout(z, 2400));
      return true;
    })()`);
    const persisted = await rowTitles('#albumDetail');
    ok('重新打开详情页顺序保持', JSON.stringify(persisted) === JSON.stringify(moved.dom),
      persisted.slice(0, 3).join(' | '));

    await ev(`document.querySelector('[data-reset-order]')?.click()`);
    await sleep(2000);
    const resetState = await ev(`(async () => {
      const d = await fetch('/api/albums/${musicOrder.id}').then(x => x.json());
      return {
        titles: [...document.querySelectorAll('#albumDetail .track-row:not(.is-head) .t-title span')].map(e => e.textContent.trim()),
        custom: d.album.custom_order,
        bar: Boolean(document.querySelector('.track-order-bar')),
      };
    })()`);
    ok('「恢复默认顺序」回到扫描顺序',
      JSON.stringify(resetState.titles) === JSON.stringify(musicOrder.titles)
      && resetState.custom === false && resetState.bar === false,
      `custom=${resetState.custom} bar=${resetState.bar}`);
  }

  const voiceOrder = await ev(`(async () => {
    const r = await fetch('/api/albums?limit=200&kind=voice').then(x => x.json());
    for (const a of r.albums) {
      const d = await fetch('/api/albums/' + a.id).then(x => x.json());
      const list = d.tracks ?? [];
      if (list.length >= 3 && list.every(t => (t.variants ?? []).every(v => v.source_kind === 'file'))) {
        location.hash = '#/album/' + a.id;
        await new Promise(z => setTimeout(z, 2600));
        return { id: a.id, titles: list.map(t => t.title), bonus: (d.bonus_tracks ?? []).length };
      }
    }
    return null;
  })()`);
  if (!voiceOrder) {
    ok('找到可拖动排序的音声发行', false, '库里没有 3 行以上本地音声');
  } else {
    await ev(`document.querySelector('#voiceTrackTable .track-row:not(.is-head)')?.scrollIntoView({ block: 'center' }); true`);
    await sleep(700);
    const vui = await ev(`({
      handles: document.querySelectorAll('#voiceTrackTable .drag-handle').length,
      rows: document.querySelectorAll('#voiceTrackTable .track-row:not(.is-head)').length,
      bonusHandles: document.querySelectorAll('.bonus-box .drag-handle').length,
    })`);
    ok('音声轨道行也有拖动手柄',
      vui.handles === vui.rows && vui.rows === voiceOrder.titles.length,
      `${vui.handles}/${vui.rows} · 特典手柄 ${vui.bonusHandles}`);

    await dragRow('#voiceTrackTable', 0, 2);
    await sleep(1800);
    const vmoved = await ev(`(async () => {
      const d = await fetch('/api/albums/${voiceOrder.id}').then(x => x.json());
      const dom = [...document.querySelectorAll('#voiceTrackTable .track-row:not(.is-head) .t-title')]
        .map(el => el.firstChild?.textContent?.trim() ?? '');
      return { dom, api: (d.tracks ?? []).map(t => t.title), custom: d.album.custom_order, bar: Boolean(document.querySelector('.track-order-bar')) };
    })()`);
    ok('音声发行拖动后顺序变化并落库',
      vmoved.dom[0] === voiceOrder.titles[1] && vmoved.dom[2] === voiceOrder.titles[0]
      && JSON.stringify(vmoved.dom) === JSON.stringify(vmoved.api) && vmoved.custom === true,
      `${vmoved.dom.slice(0, 3).join(' | ')} · custom=${vmoved.custom}`);

    await ev(`document.querySelector('[data-reset-order]')?.click()`);
    await sleep(2000);
    const vreset = await ev(`(async () => {
      const d = await fetch('/api/albums/${voiceOrder.id}').then(x => x.json());
      return { custom: d.album.custom_order, bar: Boolean(document.querySelector('.track-order-bar')) };
    })()`);
    ok('音声发行也能恢复默认顺序', vreset.custom === false && vreset.bar === false,
      `custom=${vreset.custom} bar=${vreset.bar}`);
  }
} catch (err) {
  console.error('验证异常：', err.message);
  fail += 1;
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close();
process.exit(fail ? 1 : 0);
