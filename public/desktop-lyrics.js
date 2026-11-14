/*
 * 桌面歌词窗口逻辑（v1.2.7）。
 *
 * 数据来源：
 *   · 播放状态：主窗口通过 BroadcastChannel('luna-playback') 广播（同源窗口共享）；
 *   · 歌词设置：GET /api/config 的 desktopLyrics 段；
 *   · 开关/锁定：POST /api/desktop-lyrics。
 *
 * 这个页面不碰音频、不解析歌词文件 —— 它只负责把「当前行」画出来。
 * 长句会以匀速横向滚动，并在本句结束前滚到最右（见 updateScroll）。
 */

const channel = new BroadcastChannel('luna-playback');
const $ = (sel) => document.querySelector(sel);
const root = document.documentElement;
const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v)));

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

/*
 * 打开时主动向主窗口要一次现状：BroadcastChannel 不保留历史消息，
 * 如果用户是先播放、后开歌词窗，光等广播会一直白屏。
 * 主窗口可能比本页晚一步注册好监听，所以前几次没回应时重试几轮。
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
  $('#dlTools [data-act="bare"]')?.classList.toggle('is-on', bare);
  if (v > 0) lastOpacity = v;
}

function applyMode(config) {
  root.dataset.mode = config?.appearance?.mode === 'light' ? 'light' : 'dark';
  root.dataset.theme = config?.appearance?.theme ?? 'midnight';
}

function setLocked(on) {
  locked = on === true;
  $('#dl').classList.toggle('is-locked', locked);
  $('#dlLocked').hidden = !locked;
}

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

function paint() {
  const now = view.time + (view.playing && view.at ? (performance.now() - view.at) / 1000 : 0);
  let current = '未在播放';
  let next = '';
  let trans = '';
  let empty = true;
  let index = -1;

  if (view.trackId != null) {
    if (!view.lines.length) {
      current = '♪ 暂无歌词';
    } else if (!view.synced) {
      // txt 台本这类没有时间轴：固定显示第一行，并如实说明
      current = view.lines[0]?.text ?? '';
      next = `无时间轴（${view.lines.length} 行）`;
      empty = false;
      index = 0;
    } else {
      index = indexAt(now);
      if (index < 0) {
        current = '♪';
        next = view.lines[0]?.text ?? '';
      } else {
        current = view.lines[index]?.text ?? '';
        trans = view.lines[index]?.translation ?? '';
        next = view.lines[index + 1]?.text ?? '';
        empty = false;
      }
    }
  }

  const key = [view.trackId, index, current, trans, next, empty].join('\u0001');
  if (key !== lastKey) {
    lastKey = key;
    const box = $('#dlCurrent');
    const text = $('#dlCurrentText');
    text.textContent = current;
    box.classList.toggle('is-empty', empty);

    const transEl = $('#dlTrans');
    transEl.textContent = trans;
    transEl.hidden = !trans;
    $('#dlNext').textContent = next;

    metrics.lineIndex = index;
    measure(); // 文本变了，重新量一次宽度（同步触发布局）
  }

  // 窗口 show 之前 clientWidth 是 0，量出来的 max 也是 0；等真正可见后补量一次
  if (!metrics.width || !metrics.scrollWidth) measure();

  updateScroll(now, index);
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

/* ------------------------------------------------------------- 窗口控制 */

async function post(action, extra = {}) {
  const res = await fetch('/api/desktop-lyrics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  });
  return res.json().catch(() => null);
}

$('#dlTools').addEventListener('click', async (event) => {
  const btn = event.target.closest('button[data-act]');
  if (!btn) return;
  event.stopPropagation();
  const act = btn.dataset.act;

  if (act === 'fontUp' || act === 'fontDown') {
    const next = Math.round((scale + (act === 'fontUp' ? 0.1 : -0.1)) * 10) / 10;
    applyScale(next);
    post('settings', { settings: { fontScale: scale } }).catch(() => {});
    return;
  }

  if (act === 'bare') {
    const next = bare ? (lastOpacity || 90) : 0;
    applyOpacity(next);
    post('settings', { settings: { opacity: next } }).catch(() => {});
    return;
  }

  if (act === 'lock') {
    const r = await post('lock').catch(() => null);
    if (r?.ok) setLocked(true);
    return;
  }

  if (act === 'close') {
    await post('close').catch(() => {});
  }
});

/* --------------------------------------------------------------- 拖动 */

/*
 * 不用 `-webkit-app-region: drag`：透明窗口下 Chromium 的拖拽区会给窗口
 * 顶上两个角补一块不透明底（下半圆角、上半尖角就是这么来的）。
 * 改成用鼠标位移直接 window.moveTo，圆角完全由页面自己画。
 * 拖动范围 = 整个歌词面板；只有工具栏按钮不触发拖动。
 */
const dragHandle = $('#dl');
let dragStart = null;

function onDragMove(event) {
  if (!dragStart) return;
  window.moveTo(
    dragStart.winX + (event.screenX - dragStart.px),
    dragStart.winY + (event.screenY - dragStart.py),
  );
}

function onDragEnd() {
  dragStart = null;
  window.removeEventListener('mousemove', onDragMove);
}

dragHandle.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || locked) return;
  if (event.target.closest('button')) return; // 点工具栏按钮不是在拖窗
  dragStart = {
    px: event.screenX,
    py: event.screenY,
    winX: window.screenX,
    winY: window.screenY,
  };
  event.preventDefault();
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragEnd, { once: true });
});

/* 窗口大小变化后重新量文字宽度，否则滚动终点会按旧宽度算 */
window.addEventListener('resize', () => {
  lastKey = '';
  measure();
});

/* --------------------------------------------------------------- 启动 */

async function boot() {
  try {
    const data = await (await fetch('/api/config')).json();
    applyMode(data.config);
    applyScale(data.config?.desktopLyrics?.fontScale ?? 1);
    applyOpacity(data.config?.desktopLyrics?.opacity ?? 90);
  } catch { /* 配置读不到就用默认外观 */ }

  try {
    const state = await (await fetch('/api/desktop-lyrics')).json();
    setLocked(state.locked);
  } catch { /* 非桌面环境不会走到这里 */ }
}

applyOpacity(90);
measure();
requestAnimationFrame(loop);
startHello();
boot();

/*
 * 锁定/解锁也可能从主窗口发起（鼠标穿透后就点不到本窗口了）。
 * 每秒对一次状态，保证解锁后拖拽带和工具栏立刻恢复可用。
 */
setInterval(async () => {
  try {
    const state = await (await fetch('/api/desktop-lyrics')).json();
    if (state.open && Boolean(state.locked) !== locked) setLocked(Boolean(state.locked));
  } catch { /* 窗口正在关闭时忽略 */ }
}, 1000);
