/*
 * 桌面歌词窗口逻辑。
 *
 * 数据来源：
 *   · 播放状态：主窗口通过 BroadcastChannel('luna-playback') 广播（同源窗口共享）；
 *   · 歌词设置：GET /api/config 的 desktopLyrics 段；
 *   · 开关/锁定/主窗口：POST /api/desktop-lyrics。
 *
 * 这个页面不碰音频、不解析歌词文件 —— 它只负责把「当前行」画出来。
 * 播放控制（上/下一首、暂停、±10 秒）通过同一个 BroadcastChannel 发回主窗口执行。
 *
 * 长句会以匀速横向滚动，并在本句结束前滚到最右（见 updateScroll）。
 */

const channel = new BroadcastChannel('luna-playback');
const $ = (sel) => document.querySelector(sel);
const root = document.documentElement;
const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v)));

const DEFAULT_COLOR = '#f4f4fa';
const DEFAULT_OUTLINE = 'strong';

const view = {
  trackId: null,
  title: '',
  artist: '',
  lines: [],
  synced: false,
  time: 0,
  playing: false,
  at: 0, // 收到 time 消息时的 performance.now()，用于两帧之间插值
};

let scale = 1;
let locked = false;
let bare = false;
let lastOpacity = 90;
let lastKey = '';
let metrics = { width: 0, scrollWidth: 0, lineIndex: -2 };
let color = DEFAULT_COLOR;
let outline = DEFAULT_OUTLINE;

/* --------------------------------------------------------------- 外观 */

function applyScale(value) {
  scale = clamp(value, 0.6, 2.4);
  root.style.setProperty('--dl-scale', String(scale));
}

/**
 * 背景不透明度：0 = 完全隐藏框体，只留文字（文字带阴影，压在别的窗口上也看得清）。
 * lastOpacity 记住「有背景」时的值，点「透明」切回来不至于变成 10%。
 */
function applyOpacity(value) {
  const v = clamp(value, 0, 100);
  bare = v <= 0;
  root.style.setProperty('--dl-opacity', String(v / 100));
  $('#dl').classList.toggle('is-bare', bare);
  $('#dlBareBtn')?.classList.toggle('is-on', bare);
  if (v > 0) lastOpacity = v;
}

/** 文字颜色与描边：花壁纸上单靠白色容易糊，描边给三档 */
function applyStyle(patch = {}) {
  if (typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color)) color = patch.color;
  if (['strong', 'soft', 'off'].includes(patch.outline)) outline = patch.outline;
  root.style.setProperty('--dl-fg', color);
  $('#dl').dataset.outline = outline;
  for (const swatch of document.querySelectorAll('.dl-swatch')) {
    swatch.classList.toggle('is-on', swatch.dataset.color.toLowerCase() === color.toLowerCase());
  }
  for (const btn of document.querySelectorAll('button[data-outline]')) {
    btn.classList.toggle('is-on', btn.dataset.outline === outline);
  }
}

function applyMode(config) {
  root.dataset.mode = config?.appearance?.mode === 'light' ? 'light' : 'dark';
  root.dataset.theme = config?.appearance?.theme ?? 'midnight';
}

function setLocked(on) {
  locked = on === true;
  $('#dl').classList.toggle('is-locked', locked);
  $('#dlLocked').hidden = !locked;
  if (!locked) markHover(false, true);
}

/* --------------------------------------------------------------- 悬停 */

/*
 * 锁定后窗口 setIgnoreMouseEvents(true, { forward: true })，鼠标事件被转发给窗口，
 * 但不会触发 CSS :hover（光标不在窗口的窗口过程里）。所以在页面里自己记：
 * 收到 mousemove 就把 data-hover 打开，400ms 内没有新的 mousemove 就关掉 ——
 * 光标移走以后自然不会再收到事件，靠超时复位。
 */
let hoverTimer = null;

function markHover(inside, force = false) {
  if (!force && !locked) return; // 解锁状态交给 CSS :hover，跟手且不需要脚本
  if (inside) {
    root.dataset.hover = '1';
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => { root.dataset.hover = '0'; hoverTimer = null; }, 400);
  } else {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    root.dataset.hover = '0';
  }
}


/* 锁定（鼠标穿透）时页面收不到 mousemove，由主进程轮询光标后调这个函数；
   这条路径不受 400ms 超时约束 —— 主进程会在光标离开时明确发 false。 */
window.__dlHover = (inside) => {
  if (inside) {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    root.dataset.hover = '1';
  } else {
    markHover(false, true);
  }
};

/* ----------------------------------------------------------- 行与滚动 */

/** 当前时间对应第几行（没有时间轴时返回 0；还没到第一行返回 -1） */
function indexAt(seconds) {
  const lines = view.lines;
  const ms = seconds * 1000;
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    // 歌词行的 time 与主窗口 syncLyrics 同口径，单位是**毫秒**
    if (Number(lines[i].time ?? 0) <= ms) index = i;
    else break;
  }
  return index;
}

function measure() {
  const box = $('#dlCurrent');
  const text = $('#dlCurrentText');
  metrics = { width: box.clientWidth, scrollWidth: text.scrollWidth };
}

/**
 * 长句适配：先换行，还放不下就逐级缩字号（26px 起，最小 13px）。
 * 这是我们对作者「横向匀速滚动」那一套的替换 —— ASMR 台本一行常常很长，
 * 滚过去的时候已经念到下一句了，反而是「一眼看全」更实用。
 */
function fitCurrent() {
  const box = $('#dlCurrent');
  const text = $('#dlCurrentText');
  if (!box || !text) return;
  if (box.classList.contains('is-empty')) {
    box.style.fontSize = '';
    return;
  }
  const scale = Number.parseFloat(getComputedStyle(root).getPropertyValue('--dl-scale')) || 1;
  const base = Math.round(26 * scale);
  const avail = box.clientHeight;
  const width = box.clientWidth;
  if (!avail || !width) return;

  let size = base;
  box.style.fontSize = `${size}px`;
  // 换行后的高度 / 宽度任一超出就缩 1px；最多缩到 13px
  while (size > 13 && (text.scrollHeight > avail + 1 || text.scrollWidth > width + 1)) {
    size -= 1;
    box.style.fontSize = `${size}px`;
  }
}

/**
 * 长句横向匀速滚动。
 * 滚动时长取「本句持续时间 × 0.85」，保证这句话念完之前已经停在最右；
 * 行与行之间没有时间轴（txt 台本 / 最后一行）时给固定 10 秒。
 */
function updateScroll(seconds, index) {
  const text = $('#dlCurrentText');
  const max = metrics.scrollWidth - metrics.width;
  if (max <= 0) {
    if (text.style.transform) text.style.transform = '';
    return;
  }

  let startMs = 0;
  let endMs = 10000;
  if (view.synced && index >= 0) {
    startMs = Number(view.lines[index]?.time ?? 0);
    const next = view.lines[index + 1];
    endMs = next ? Number(next.time) : startMs + 6000;
  }
  const span = Math.max(1500, Math.min((endMs - startMs) * 0.85, 10000));
  const elapsed = Math.max(0, seconds * 1000 - startMs);
  const progress = Math.min(1, elapsed / span);
  text.style.transform = `translateX(${(-max * progress).toFixed(1)}px)`;
}

/* ------------------------------------------------------------- 绘制 */

function paintPlayButton() {
  const btn = $('#dlPlayBtn');
  if (!btn) return;
  const glyph = view.playing ? '⏸' : '▶';
  if (btn.textContent !== glyph) btn.textContent = glyph;
}

function paint() {
  const now = view.time + (view.playing && view.at ? (performance.now() - view.at) / 1000 : 0);
  let current = '未在播放';
  let trans = '';
  let empty = true;
  let index = -1;

  if (view.trackId != null) {
    if (!view.lines.length) {
      current = '♪ 暂无歌词';
    } else if (!view.synced) {
      // txt 台本这类没有时间轴：固定显示第一行，并如实说明
      current = view.lines[0]?.text ?? '';
      empty = false;
      index = 0;
    } else {
      index = indexAt(now);
      if (index < 0) {
        current = '♪';
      } else {
        current = view.lines[index]?.text ?? '';
        trans = view.lines[index]?.translation ?? '';
        empty = false;
      }
    }
  }

  const key = [view.trackId, index, current, trans, empty].join('\u0001');
  if (key !== lastKey) {
    lastKey = key;
    const box = $('#dlCurrent');
    const text = $('#dlCurrentText');
    text.textContent = current;
    box.classList.toggle('is-empty', empty);

    const transEl = $('#dlTrans');
    transEl.textContent = trans;
    transEl.hidden = !trans;

    metrics.lineIndex = index;
    measure(); // 文本变了，重新量一次宽度（同步触发布局）
    fitCurrent();
  }

  // 窗口 show 之前 clientWidth 是 0，量出来的 max 也是 0；等真正可见后补量一次
  if (!metrics.width || !metrics.scrollWidth) measure();

  paintPlayButton();
}

function loop() {
  paint();
  requestAnimationFrame(loop);
}

/* ------------------------------------------------------------- 状态接收 */

channel.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'track') {
    stopHello();
    const sameTrack = Number(msg.trackId) === Number(view.trackId);
    view.trackId = msg.trackId ?? null;
    view.title = msg.title ?? '';
    view.artist = msg.artist ?? '';
    view.time = 0;
    view.playing = false;
    view.at = 0;
    if (!sameTrack) {
      view.lines = Array.isArray(msg.lines) ? msg.lines : [];
      view.synced = msg.synced === true;
    }
    lastKey = '';
    return;
  }

  if (msg.type === 'lyrics') {
    if (Number(msg.trackId) !== Number(view.trackId)) return;
    view.lines = Array.isArray(msg.lines) ? msg.lines : [];
    view.synced = msg.synced === true;
    lastKey = '';
    return;
  }

  if (msg.type === 'time') {
    if (Number(msg.trackId) !== Number(view.trackId)) return;
    view.time = Number(msg.time) || 0;
    view.playing = msg.playing === true;
    view.at = view.playing ? performance.now() : 0;
    return;
  }

  if (msg.type === 'idle') {
    view.trackId = null;
    view.lines = [];
    view.synced = false;
    view.time = 0;
    view.playing = false;
    view.at = 0;
    lastKey = '';
  }
};

/*
 * 打开时主动向主窗口要一次现状：BroadcastChannel 不保留历史消息，
 * 如果用户是先播放、后开歌词窗，光等广播会一直白屏。
 */
let helloCount = 0;
let helloTimer = null;
function askForState() {
  try { channel.postMessage({ type: 'hello' }); } catch { /* 忽略 */ }
}
function stopHello() {
  if (helloTimer) { clearInterval(helloTimer); helloTimer = null; }
}
function startHello() {
  askForState();
  helloTimer = setInterval(() => {
    if (view.trackId != null || helloCount >= 12) { stopHello(); return; }
    helloCount += 1;
    askForState();
  }, 400);
}

/* ------------------------------------------------------------- 窗口控制 */

async function post(action, extra = {}) {
  const res = await fetch('/api/desktop-lyrics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  });
  return res.json().catch(() => null);
}

/** 播放控制要交给主窗口做 —— 音频元素只在那边 */
function sendCommand(action, value) {
  try { channel.postMessage({ type: 'cmd', action, value }); } catch { /* 忽略 */ }
}

$('#dlTools').addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-act]');
  if (!btn) return;
  event.stopPropagation();
  const act = btn.dataset.act;

  if (act === 'main') { await post('focus-main').catch(() => {}); return; }
  if (act === 'prev') { sendCommand('prev'); return; }
  if (act === 'next') { sendCommand('next'); return; }
  if (act === 'toggle') { sendCommand('toggle'); return; }
  if (act === 'back10') { sendCommand('seek', -10); return; }
  if (act === 'fwd10') { sendCommand('seek', 10); return; }

  if (act === 'lock') {
    const r = await post('lock').catch(() => null);
    if (r?.ok) setLocked(true);
    return;
  }

  if (act === 'close') {
    await post('close').catch(() => {});
  }
});

/* ------------------------------------------------------------- 右键菜单 */

/*
 * 右键菜单是主进程另开的一个**独立小窗口**（desktop-lyrics-menu.html），贴着光标弹。
 * 不在这个窗口里画面板：歌词窗只有 150px 高，竖排菜单放不下；盖在歌词上又没法边调边看。
 */
$('#dl').addEventListener('contextmenu', (event) => {
  if (locked) return;
  event.preventDefault();
  post('context-menu').catch(() => {});
});

/** 主进程改完设置后回调它，把最新的配置重新应用一遍 */
async function refreshFromServer() {
  try {
    const data = await (await fetch('/api/config')).json();
    const cfg = data.config?.desktopLyrics ?? {};
    applyMode(data.config);
    applyScale(cfg.fontScale ?? 1);
    applyOpacity(cfg.opacity ?? 90);
    applyStyle({ color: cfg.color ?? DEFAULT_COLOR, outline: cfg.outline ?? DEFAULT_OUTLINE });
  } catch { /* 读不到就保持现状 */ }
  try {
    const state = await (await fetch('/api/desktop-lyrics')).json();
    setLocked(state.locked === true);
  } catch { /* 同上 */ }
}

window.__dlRefresh = refreshFromServer;

/** 悬停预览：只改画面不落盘，离开菜单项时由菜单再调一次 refresh 还原 */
window.__dlPreview = (patch = {}) => {
  if (patch.fontScale) applyScale(patch.fontScale);
  if (patch.opacity !== undefined && patch.opacity !== null) applyOpacity(patch.opacity);
  if (patch.color || patch.outline) applyStyle({ color: patch.color, outline: patch.outline });
  lastKey = '';
  paint();
};

/* --------------------------------------------------------------- 拖动 */

/*
 * 不用 `-webkit-app-region: drag`：透明窗口下 Chromium 的拖拽区会给窗口
 * 顶上两个角补一块不透明底（下半圆角、上半尖角就是这么来的）。
 * 改成用鼠标位移直接 window.moveTo，圆角完全由页面自己画。
 * 拖动范围 = 整个歌词面板；只有工具栏按钮、右键菜单不触发拖动。
 */
const dragHandle = $('#dl');
let dragStart = null;

function onDragMove(event) {
  if (!dragStart) return;
  window.moveTo(
    dragStart.winX + (event.screenX - dragStart.px),
    dragStart.winY + (event.screenY - dragStart.py),
  );
  // Windows 在移动透明无边框窗时会顺手改动尺寸（每次 1~2px），
  // 拖动过程中把它按回起始尺寸，否则按住鼠标窗口会越长越大。
  if (dragStart.w !== window.outerWidth || dragStart.h !== window.outerHeight) {
    window.resizeTo(dragStart.w, dragStart.h);
  }
}

function onDragEnd() {
  const start = dragStart;
  dragStart = null;
  window.removeEventListener('mousemove', onDragMove);
  // 收尾把尺寸钉回去：拖动过程中 Windows 会给窗口补 1~2px，攒几次就明显变大
  if (start) {
    post('fix-size', { width: start.w, height: start.h }).catch(() => {});
  }
}

dragHandle.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || locked) return;
  if (event.target.closest('button')) return; // 点工具栏按钮不是在拖窗
  dragStart = {
    px: event.screenX,
    py: event.screenY,
    winX: window.screenX,
    winY: window.screenY,
    w: window.outerWidth,
    h: window.outerHeight,
  };
  event.preventDefault();
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragEnd, { once: true });
});

/* 窗口大小变化后重新量文字宽度，否则滚动终点会按旧宽度算 */
window.addEventListener('resize', () => {
  fitCurrent();
  lastKey = '';
  measure();
});

/* --------------------------------------------------------------- 启动 */

async function boot() {
  try {
    const data = await (await fetch('/api/config')).json();
    const cfg = data.config?.desktopLyrics ?? {};
    applyMode(data.config);
    applyScale(cfg.fontScale ?? 1);
    applyOpacity(cfg.opacity ?? 90);
    applyStyle({ color: cfg.color ?? DEFAULT_COLOR, outline: cfg.outline ?? DEFAULT_OUTLINE });
  } catch { /* 配置读不到就用默认外观 */ }

  try {
    const state = await (await fetch('/api/desktop-lyrics')).json();
    setLocked(state.locked);
  } catch { /* 非桌面环境不会走到这里 */ }
}

applyOpacity(90);
applyStyle({});
measure();
requestAnimationFrame(loop);
startHello();
boot();

/*
 * 锁定/解锁也可能从主窗口或全局快捷键发起（鼠标穿透后就点不到本窗口了）。
 * 每秒对一次状态，保证解锁后拖拽带和工具栏立刻恢复可用。
 */
setInterval(async () => {
  try {
    const state = await (await fetch('/api/desktop-lyrics')).json();
    if (state.open && Boolean(state.locked) !== locked) setLocked(Boolean(state.locked));
  } catch { /* 窗口正在关闭时忽略 */ }
}, 1000);
