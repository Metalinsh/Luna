/**
 * 桌面歌词（v1.2.7）。
 *
 * 验证的是「窗口 + 数据链路 + 交互」，不真的播放音频：
 *   · 接口能在主进程里开出第二个窗口；
 *   · 歌词窗口能收到主窗口广播的当前行/下一行；
 *   · 锁定 = 鼠标穿透（窗口侧状态同步）；
 *   · 字号设置会落进配置；
 *   · 关闭后状态归零。
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

  overlay = await connect((url) => url.includes('desktop-lyrics.html'));
  await sleep(800);
  console.log('\n— 需求2：播放状态与歌词行 —');
  ok('歌词窗口初始显示「未在播放」',
    (await overlay.eval(`document.querySelector('#dlCurrent').textContent`)) === '未在播放');

  // 主窗口广播（模拟播放器事件），歌词窗口应立刻更新
  // 注意时间轴单位与主窗口一致是**毫秒**：用真实量级的 7.4s / 11.5s 才能测出单位错误
  await mainPage.eval(`new BroadcastChannel('luna-playback').postMessage({
    type: 'track', trackId: 1, title: '测试曲', artist: '测试',
    lines: [{ time: 7429, text: '第一行歌词' }, { time: 11539, text: '第二行歌词' }], synced: true,
  }); true`);
  await sleep(300);
  await mainPage.eval(`new BroadcastChannel('luna-playback').postMessage({ type: 'time', trackId: 1, time: 3.2, playing: false }); true`);
  await sleep(400);
  ok('未到第一行时显示 ♪ 并预告下一行',
    (await overlay.eval(`document.querySelector('#dlCurrent').textContent`)) === '♪'
    && (await overlay.eval(`document.querySelector('#dlNext').textContent`)) === '第一行歌词');

  await mainPage.eval(`new BroadcastChannel('luna-playback').postMessage({ type: 'time', trackId: 1, time: 12, playing: false }); true`);
  await sleep(400);
  ok('当前行按毫秒时间轴推进',
    (await overlay.eval(`document.querySelector('#dlCurrent').textContent`)) === '第二行歌词',
    await overlay.eval(`document.querySelector('#dlCurrent').textContent`));
  ok('下一行留空（已是最后一行）',
    (await overlay.eval(`document.querySelector('#dlNext').textContent`)) === '');
  ok('歌词窗口是半透明实底（不是全透明看不见）',
    /rgba?\(/.test(await overlay.eval(`getComputedStyle(document.querySelector('#dl')).backgroundColor`)),
    await overlay.eval(`getComputedStyle(document.querySelector('#dl')).backgroundColor`));

  console.log('\n— 需求3：锁定 / 字号 / 关闭 —');
  await overlay.eval(`document.querySelector('[data-act="lock"]').click(); true`);
  await sleep(600);
  const locked = await j('/api/desktop-lyrics');
  ok('锁定状态同步到接口', locked.locked === true);
  ok('窗口进入锁定态（工具栏隐藏）',
    (await overlay.eval(`document.querySelector('#dl').classList.contains('is-locked')`)) === true);

  await post('/api/desktop-lyrics', { action: 'unlock' });
  const unlocked = await j('/api/desktop-lyrics');
  ok('解锁后恢复交互', unlocked.locked === false);
  await sleep(1200); // 窗口每秒对一次锁定状态（主窗口解锁后要等它同步）

  // 拖动：整个歌词面板都可拖（不再只有顶部一条），用 mousemove + window.moveTo 实现
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

  const scaleBefore = Number((await j('/api/config')).config?.desktopLyrics?.fontScale ?? 1);
  await overlay.eval(`document.querySelector('[data-act="fontUp"]').click(); true`);
  await sleep(500);
  const scaleAfter = Number((await j('/api/config')).config?.desktopLyrics?.fontScale ?? 1);
  ok('字号 + 会写进配置', Math.abs(scaleAfter - Math.min(2.4, scaleBefore + 0.1)) < 0.001,
    `${scaleBefore} → ${scaleAfter}`);
  ok('窗口同步放大', Number(await overlay.eval(
    `getComputedStyle(document.documentElement).getPropertyValue('--dl-scale').trim()`)) === scaleAfter);

  console.log('\n— 需求4：长句横向滚动与完全透明 —');
  const longLine = '这是一句非常长的歌词，用来测试桌面歌词窗口的自动横向匀速滚动，'
    + '应该在整句念完之前平稳地滚到最右边，而不是被省略号截断。';
  await mainPage.eval(`new BroadcastChannel('luna-playback').postMessage({
    type: 'track', trackId: 2, title: '长句测试', artist: '',
    lines: [{ time: 0, text: ${JSON.stringify(longLine)} }, { time: 10000, text: '下一句' }], synced: true,
  }); true`);
  await sleep(250);

  const readScroll = async (seconds) => {
    await mainPage.eval(`new BroadcastChannel('luna-playback').postMessage({ type: 'time', trackId: 2, time: ${seconds}, playing: false }); true`);
    await sleep(350);
    return overlay.eval(`(() => {
      const box = document.querySelector('#dlCurrent');
      const text = document.querySelector('#dlCurrentText');
      const m = getComputedStyle(text).transform;
      return {
        tx: m.startsWith('matrix') ? Number(m.split(',')[4]) : 0,
        max: text.scrollWidth - box.clientWidth,
      };
    })()`);
  };

  const scroll1 = await readScroll(1);
  const scroll2 = await readScroll(8.6);
  ok('长句宽度超过窗口（才会触发滚动）', scroll1.max > 40, `超出 ${scroll1.max}px`);
  ok('当前行向左匀速滚动', scroll2.tx < scroll1.tx - 20, `t=1s ${scroll1.tx}px → t=8.6s ${scroll2.tx}px`);
  ok('本句结束前已滚到最右', Math.abs(scroll2.tx + scroll2.max) < 30,
    `停在 ${scroll2.tx}px / 最右 -${scroll2.max}px`);

  await overlay.eval(`document.querySelector('[data-act="bare"]').click(); true`);
  await sleep(500);
  const bareState = await overlay.eval(`({
    bg: getComputedStyle(document.querySelector('#dl')).backgroundColor,
    bare: document.querySelector('#dl').classList.contains('is-bare'),
  })`);
  const bareConfig = (await j('/api/config')).config?.desktopLyrics ?? {};
  ok('点「透明」后框体完全透明（只留文字）',
    bareState.bare === true && /rgba\(0, 0, 0, 0\)|transparent/.test(bareState.bg), bareState.bg);
  ok('透明度 0 写进配置', Number(bareConfig.opacity) === 0, String(bareConfig.opacity));

  await overlay.eval(`document.querySelector('[data-act="bare"]').click(); true`);
  await sleep(400);
  ok('再点一次恢复背景',
    /rgba\(\d/.test(await overlay.eval(`getComputedStyle(document.querySelector('#dl')).backgroundColor`)));

  const closed = await post('/api/desktop-lyrics', { action: 'close' });
  ok('关闭后 open=false', closed.open === false);
  ok('关闭状态写回配置', closed.config?.enabled === false);
} finally {
  // 还原配置（坐标 / 字号 / 开关），别把检查过程留在用户设置里
  try {
    await post('/api/desktop-lyrics', { action: 'close' });
    await post('/api/desktop-lyrics', { action: 'settings', settings: originalConfig ?? {} });
  } catch { /* 尽力而为 */ }
  overlay?.close?.();
  mainPage?.close?.();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
