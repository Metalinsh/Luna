/**
 * 桌面歌词（v1.2.7）。
 *
 * 覆盖合并 PR 之后的新形态：
 *   · 单行歌词：不再有「下一行预告」，长句改为**换行 + 逐级缩小字号**（fitCurrent）；
 *   · 播放工具条：主窗口 / 上一首 / 播放暂停 / 下一首 / ±10 秒 / 锁定 / 关闭；
 *   · 右键菜单独立小窗（本脚本只验证接口层，菜单 UI 由人工试）；
 *   · 字号 / 颜色 / 描边 / 背景（透明）通过 settings 接口生效并刷新窗口。
 *
 * 运行器会先起好 Electron 开发实例（主窗口 8799 / CDP 9360）。
 */
const API = 'http://127.0.0.1:8799';
const CDP = 'http://127.0.0.1:9360';

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass += 1; console.log(`  PASS  ${n}${e ? `  (${e})` : ''}`); } else { fail += 1; console.log(`  FAIL  ${n}${e ? `  (${e})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, o) => (await fetch(API + p, o)).json();
const post = (p, body) => j(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** 连到指定窗口；返回 eval(expression) */
async function connect(predicate) {
  for (let i = 0; i < 80; i += 1) {
    const list = await (await fetch(`${CDP}/json/list`)).json().catch(() => []);
    const page = list.find((t) => t.type === 'page' && predicate(t.url ?? ''));
    if (page) {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
      let id = 0;
      const pending = new Map();
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      };
      return {
        eval: (expression) => new Promise((resolve, reject) => {
          id += 1;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('求值超时（窗口可能已关闭）'));
          }, 20000);
          pending.set(id, (msg) => {
            clearTimeout(timer);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result?.result?.value);
          });
          ws.send(JSON.stringify({
            id, method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true },
          }));
        }),
        close: () => ws.close(),
      };
    }
    await sleep(250);
  }
  throw new Error('找不到目标窗口');
}

const originalConfig = (await j('/api/config')).config?.desktopLyrics ?? null;
let mainPage = null;
let overlay = null;

try {
  // 注意排除桌面歌词页：它的 URL 同样以 http://127.0.0.1:8799 开头
  mainPage = await connect((url) => url.startsWith('http://127.0.0.1:8799') && !url.includes('desktop-lyrics'));
  /*
   * 前面的区域可能留下播放队列 / 正在播放状态：歌词窗加载时会发 hello，
   * 主窗口会把「当前曲目 + 进度」回给新窗口，初始文案就变成 ♪ 而不是「未在播放」。
   * 先重载主窗口把状态归零，保证本区域单独跑与全量顺序跑结果一致。
   */
  await mainPage.eval('location.reload(), true');
  await sleep(4500);
  await mainPage.eval(`(() => {
    const a = document.querySelector('audio');
    if (a) { a.pause(); a.currentTime = 0; }
    return true;
  })()`);
  await sleep(400);
  ok('主界面已去掉「歌词」按钮（歌词改由桌面歌词承担）',
    (await mainPage.eval(`!!document.querySelector('#lyricsBtn')`)) === false);
  ok('桌面歌词按钮仍在播放条上',
    (await mainPage.eval(`!!document.querySelector('#desktopLyricsBtn')`)) === true);

  console.log('\n— 需求1：接口能打开桌面歌词窗口 —');
  const before = await j('/api/desktop-lyrics');
  ok('桌面版报告可用', before.available === true, JSON.stringify(before.config));
  // 兼容「上次退出时窗口是打开的」：先关掉再测
  if (before.open) await post('/api/desktop-lyrics', { action: 'close' });
  const closedBefore = await j('/api/desktop-lyrics');
  ok('默认是关闭的', closedBefore.open === false, String(closedBefore.open));

  const opened = await post('/api/desktop-lyrics', { action: 'open' });
  ok('open 返回 ok', opened.ok === true);
  ok('窗口已打开', opened.open === true);
  ok('窗口有实际坐标（不是 0,0 的假位置）',
    opened.bounds && (opened.bounds.x !== 0 || opened.bounds.y !== 0),
    JSON.stringify(opened.bounds));
  ok('打开状态写入配置', opened.config?.enabled === true);
  ok('配置包含文字颜色与描边', /^#[0-9a-f]{6}$/i.test(opened.config?.color ?? '')
    && ['strong', 'soft', 'off'].includes(opened.config?.outline ?? ''), `${opened.config?.color} / ${opened.config?.outline}`);

  overlay = await connect((url) => url.includes('desktop-lyrics.html'));
  await sleep(800);

  console.log('\n— 需求2：单行歌词与时间轴 —');
  let initialText = '';
  for (let i = 0; i < 10; i += 1) {
    initialText = await overlay.eval(`document.querySelector('#dlCurrent')?.textContent ?? ''`);
    if (initialText === '未在播放') break;
    await sleep(200);
  }
  ok('歌词窗口初始显示「未在播放」', initialText === '未在播放', initialText);

  // 主窗口广播（模拟播放器事件），歌词窗口应立刻更新
  // 注意时间轴单位与主窗口一致是**毫秒**：用真实量级的 7.4s / 11.5s 才能测出单位错误
  await mainPage.eval(`new BroadcastChannel('luna-playback').postMessage({
    type: 'track', trackId: 1, title: '测试曲', artist: '测试',
    lines: [{ time: 7429, text: '第一行歌词' }, { time: 11539, text: '第二行歌词' }], synced: true,
  }); true`);
  await sleep(300);
  await mainPage.eval(`new BroadcastChannel('luna-playback').postMessage({ type: 'time', trackId: 1, time: 3.2, playing: false }); true`);
  await sleep(400);
  ok('未到第一行时只显示 ♪（单行模式没有下一行预告）',
    (await overlay.eval(`document.querySelector('#dlCurrent').textContent`)) === '♪'
    && (await overlay.eval(`!!document.querySelector('#dlNext')`)) === false);

  await mainPage.eval(`new BroadcastChannel('luna-playback').postMessage({ type: 'time', trackId: 1, time: 12, playing: false }); true`);
  await sleep(400);
  ok('当前行按毫秒时间轴推进',
    (await overlay.eval(`document.querySelector('#dlCurrent').textContent`)) === '第二行歌词',
    await overlay.eval(`document.querySelector('#dlCurrent').textContent`));
  ok('歌词窗口是半透明实底（不是全透明看不见）',
    /rgba?\(/.test(await overlay.eval(`getComputedStyle(document.querySelector('#dl')).backgroundColor`)),
    await overlay.eval(`getComputedStyle(document.querySelector('#dl')).backgroundColor`));

  console.log('\n— 需求3：播放工具条 —');
  const toolbar = await overlay.eval(`[...document.querySelectorAll('#dlTools button')].map((b) => b.dataset.act)`);
  const need = ['main', 'prev', 'toggle', 'next', 'back10', 'fwd10', 'lock', 'close'];
  ok('工具条包含主窗口/切歌/播放/快进/锁定/关闭',
    need.every((a) => toolbar.includes(a)), toolbar.join(', '));
  ok('播放键显示 ▶（当前未在播放）',
    (await overlay.eval(`document.querySelector('#dlPlayBtn').textContent`)) === '▶');

  // 工具条命令通过 BroadcastChannel 交回主窗口执行
  await mainPage.eval(`(() => {
    window.__dlCmds = [];
    window.__dlCh = new BroadcastChannel('luna-playback');
    window.__dlCh.onmessage = (e) => { if (e.data?.type === 'cmd') window.__dlCmds.push(e.data); };
    return true;
  })()`);
  await overlay.eval(`document.querySelector('[data-act="toggle"]').click(); true`);
  await sleep(400);
  const cmds = await mainPage.eval(`window.__dlCmds`);
  ok('点播放键 → 主窗口收到 toggle 命令',
    Array.isArray(cmds) && cmds.some((c) => c.action === 'toggle'), JSON.stringify(cmds));

  console.log('\n— 需求4：锁定 / 解锁 —');
  await overlay.eval(`document.querySelector('[data-act="lock"]').click(); true`);
  await sleep(700);
  const locked = await j('/api/desktop-lyrics');
  ok('锁定状态同步到接口', locked.locked === true);
  ok('窗口进入锁定态（工具栏隐藏）',
    (await overlay.eval(`document.querySelector('#dl').classList.contains('is-locked')`)) === true);

  await post('/api/desktop-lyrics', { action: 'unlock' });
  const unlocked = await j('/api/desktop-lyrics');
  ok('解锁后恢复交互', unlocked.locked === false);
  await sleep(1200); // 窗口每秒对一次锁定状态（主窗口解锁后要等它同步）

  // 拖动：整个歌词面板都可拖，用 mousemove + window.moveTo 实现
  const posBefore = await overlay.eval(`({ x: screenX, y: screenY })`);
  await overlay.eval(`(() => {
    const h = document.querySelector('#dlCurrent');
    h.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, screenX: 800, screenY: 800 }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, screenX: 840, screenY: 820 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  })()`);
  await sleep(500);
  const posAfter = await overlay.eval(`({ x: screenX, y: screenY })`);
  ok('按住歌词区域任意位置可以拖动窗口',
    posAfter.x === posBefore.x + 40 && posAfter.y === posBefore.y + 20,
    `${posBefore.x},${posBefore.y} → ${posAfter.x},${posAfter.y}`);

  // 工具栏按钮上按下鼠标不应拖动窗口
  await overlay.eval(`(() => {
    const btn = document.querySelector('#dlTools button');
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, screenX: 800, screenY: 800 }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, screenX: 900, screenY: 900 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  const posAfterBtn = await overlay.eval(`({ x: screenX, y: screenY })`);
  ok('点工具栏按钮不会误拖窗口',
    posAfterBtn.x === posAfter.x && posAfterBtn.y === posAfter.y,
    `${posAfter.x},${posAfter.y} → ${posAfterBtn.x},${posAfterBtn.y}`);

  console.log('\n— 需求5：字号 / 颜色 / 描边 / 透明 —');
  const cfgBefore = (await j('/api/config')).config?.desktopLyrics ?? {};
  const nextScale = Math.min(2.4, Math.round((Number(cfgBefore.fontScale) + 0.1) * 10) / 10);
  await post('/api/desktop-lyrics', { action: 'settings', settings: { fontScale: nextScale } });
  await sleep(700);
  const cfgScale = (await j('/api/config')).config?.desktopLyrics ?? {};
  ok('字号设置写进配置', Math.abs(Number(cfgScale.fontScale) - nextScale) < 0.001,
    `${cfgBefore.fontScale} → ${cfgScale.fontScale}`);
  ok('窗口同步放大', Number(await overlay.eval(
    `getComputedStyle(document.documentElement).getPropertyValue('--dl-scale').trim()`)) === nextScale);

  await post('/api/desktop-lyrics', { action: 'settings', settings: { color: '#ffe27a', outline: 'soft' } });
  await sleep(700);
  const styleState = await overlay.eval(`({
    color: getComputedStyle(document.documentElement).getPropertyValue('--dl-fg').trim(),
    outline: document.querySelector('#dl').dataset.outline,
  })`);
  ok('文字颜色生效', styleState.color.toLowerCase() === '#ffe27a', styleState.color);
  ok('描边档位生效', styleState.outline === 'soft', styleState.outline);

  await post('/api/desktop-lyrics', { action: 'settings', settings: { opacity: 0 } });
  await sleep(700);
  const bareState = await overlay.eval(`({
    bg: getComputedStyle(document.querySelector('#dl')).backgroundColor,
    bare: document.querySelector('#dl').classList.contains('is-bare'),
  })`);
  ok('背景设为 0 后框体完全透明（只留文字）',
    bareState.bare === true && /rgba\(0, 0, 0, 0\)|transparent/.test(bareState.bg), bareState.bg);
  ok('透明度 0 写进配置',
    Number((await j('/api/config')).config?.desktopLyrics?.opacity) === 0);

  await post('/api/desktop-lyrics', { action: 'settings', settings: { opacity: 90 } });
  await sleep(500);
  ok('恢复背景后框体重新可见',
    /rgba\(\d/.test(await overlay.eval(`getComputedStyle(document.querySelector('#dl')).backgroundColor`)));

  console.log('\n— 需求6：长句适配（换行 + 缩字号，不再横向滚动） —');
  const longLine = '这是一句非常长的歌词，用来测试桌面歌词窗口在单行模式下如何自动换行并逐级缩小字号，'
    + '保证整句话能完整显示在窗口里，而不是被省略号截断，也不会横向滚出去。';
  await mainPage.eval(`new BroadcastChannel('luna-playback').postMessage({
    type: 'track', trackId: 2, title: '长句测试', artist: '',
    lines: [{ time: 0, text: ${JSON.stringify(longLine)} }, { time: 10000, text: '下一句' }], synced: true,
  }); true`);
  await sleep(300);
  await mainPage.eval(`new BroadcastChannel('luna-playback').postMessage({ type: 'time', trackId: 2, time: 1, playing: false }); true`);
  await sleep(500);
  const fit = await overlay.eval(`(() => {
    const box = document.querySelector('#dlCurrent');
    const text = document.querySelector('#dlCurrentText');
    const scale = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dl-scale')) || 1;
    return {
      fontSize: Number.parseFloat(getComputedStyle(box).fontSize),
      base: 26 * scale,
      boxW: box.clientWidth, textW: text.scrollWidth,
      boxH: box.clientHeight, textH: text.scrollHeight,
      transform: getComputedStyle(text).transform,
    };
  })()`);
  ok('长句触发字号缩小', fit.fontSize < fit.base - 0.5, `${fit.fontSize}px < ${fit.base}px`);
  ok('不出现横向溢出（单行/多行都收在窗口内）', fit.textW <= fit.boxW + 1,
    `${fit.textW}px / ${fit.boxW}px`);
  ok('没有横向滚动位移', fit.transform === 'none' || fit.transform === 'matrix(1, 0, 0, 1, 0, 0)',
    fit.transform);

  const closed = await post('/api/desktop-lyrics', { action: 'close' });
  ok('关闭后 open=false', closed.open === false);
  ok('关闭状态写回配置', closed.config?.enabled === false);
} finally {
  // 还原配置（坐标 / 字号 / 颜色 / 透明度 / 开关），别把检查过程留在用户设置里
  try {
    await post('/api/desktop-lyrics', { action: 'close' });
    await post('/api/desktop-lyrics', { action: 'settings', settings: originalConfig ?? {} });
  } catch { /* 尽力而为 */ }
  overlay?.close?.();
  mainPage?.close?.();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
