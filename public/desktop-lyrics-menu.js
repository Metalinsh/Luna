/*
 * 桌面歌词的右键菜单（独立小窗口）。
 *
 * 为什么单独开窗：歌词窗只有 150px 高，竖排菜单放不下；而且菜单盖在歌词上
 * 就没法边调边看。小窗贴在光标旁边，点外面（失去焦点）服务端会自动收掉。
 */

const COLORS = [
  ['白色', '#f4f4fa'],
  ['黄色', '#ffe27a'],
  ['红色', '#ff6b6b'],
  ['黑色', '#0b0b0f'],
];
const OUTLINES = [['强', 'strong'], ['柔', 'soft'], ['关', 'off']];

const menu = document.getElementById('menu');

let cfg = {};
let state = {};

async function post(action, extra = {}) {
  const res = await fetch('/api/desktop-lyrics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  });
  return res.json().catch(() => null);
}

/* 悬停预览：改画面不落盘；离开这一组时按已保存的配置还原 */
let previewing = false;

function preview(patch) {
  previewing = true;
  post('preview', { settings: patch }).catch(() => {});
}

function endPreview() {
  if (!previewing) return;
  previewing = false;
  post('preview', { settings: cfg }).catch(() => {});
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function item(label, onClick, { on = false, title = '' } = {}) {
  const btn = el('button', 'item', label);
  btn.type = 'button';
  if (on) btn.classList.add('is-on');
  if (title) btn.title = title;
  btn.addEventListener('click', async () => {
    await onClick();
  });
  btn.addEventListener('mouseenter', endPreview);
  return btn;
}

function row(label, children) {
  const box = el('div', 'row');
  box.append(el('span', 'label', label));
  for (const child of children) box.append(child);
  return box;
}

function chip(text, on, { onHover, onClick } = {}) {
  const btn = el('button', 'chip', text);
  btn.type = 'button';
  if (on) btn.classList.add('is-on');
  if (onHover) btn.addEventListener('mouseenter', onHover);
  if (onClick) btn.addEventListener('click', onClick);
  btn.addEventListener('mouseleave', endPreview);
  return btn;
}

function render() {
  menu.textContent = '';

  menu.append(item(state.locked ? '解锁歌词（鼠标可点）' : '锁定歌词（鼠标穿透）', async () => {
    await post(state.locked ? 'unlock' : 'lock');
    await finish('locked', !state.locked);
  }));

  menu.append(el('div', 'sep'));

  const scale = Number(cfg.fontScale) || 1;
  menu.append(row('字号', [
    chip('A−', false, { onClick: () => save({ fontScale: Math.max(0.6, Math.round((scale - 0.1) * 10) / 10) }) }),
    chip('A＋', false, { onClick: () => save({ fontScale: Math.min(2.4, Math.round((scale + 0.1) * 10) / 10) }) }),
    chip(`${Math.round(scale * 100)}%`, false, { onClick: () => save({ fontScale: 1 }) }),
  ]));

  const swatches = COLORS.map(([name, color]) => {
    const btn = el('button', 'swatch');
    btn.type = 'button';
    btn.title = name;
    btn.style.background = color;
    if (String(cfg.color).toLowerCase() === color) btn.classList.add('is-on');
    btn.addEventListener('mouseenter', () => preview({ color }));
    btn.addEventListener('mouseleave', endPreview);
    btn.addEventListener('click', () => save({ color }));
    return btn;
  });
  menu.append(row('颜色', swatches));

  menu.append(row('描边', OUTLINES.map(([label, outline]) => chip(label, cfg.outline === outline, {
    onHover: () => preview({ outline }),
    onClick: () => save({ outline }),
  }))));

  menu.append(row('背景', [
    chip('底板', Number(cfg.opacity) > 0, { onClick: () => save({ opacity: 90 }) }),
    chip('仅文字', Number(cfg.opacity) <= 0, { onClick: () => save({ opacity: 0 }) }),
  ]));

  menu.append(el('div', 'sep'));

  menu.append(item('刷新歌词窗口（修白条）', async () => {
    await post('rebuild');
    await close();
  }));
  menu.append(item('关闭桌面歌词', async () => {
    await post('close');
    await close();
  }));

  // 窗口高度跟着内容走（这个窗口是 resizable:false，只能靠 resizeTo 改）
  requestAnimationFrame(() => {
    const h = Math.ceil(menu.getBoundingClientRect().height) + 8;
    window.resizeTo(208, h);
  });
}

async function save(patch) {
  Object.assign(cfg, patch);
  await post('settings', { settings: patch });
  await close();
}

async function finish(key, value) {
  if (key === 'locked') state.locked = value;
  await close();
}

async function close() {
  await post('close-menu');
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') close();
});

async function boot() {
  try {
    const [config, status] = await Promise.all([
      fetch('/api/config').then((r) => r.json()),
      fetch('/api/desktop-lyrics').then((r) => r.json()),
    ]);
    cfg = config.config?.desktopLyrics ?? {};
    state = status ?? {};
  } catch { /* 读不到就用默认值渲染 */ }
  render();
}

boot();
