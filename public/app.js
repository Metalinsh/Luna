/* 本地专辑管理软件 V2.1 —— 前端逻辑（原生 ES 模块，零依赖） */

/* ------------------------------------------------------------------ 工具 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const fmtTime = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
};

const fmtLong = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 分钟';
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  return h > 0 ? `${h} 小时 ${total % 60} 分钟` : `${total} 分钟`;
};

const fmtBytes = (n) => {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

const debounce = (fn, ms = 260) => {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error ?? `请求失败（${res.status}）`);
  return data;
}

let toastTimer;
function toast(message, isError = false, action = null) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(message)}</span>`;
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost';
    btn.style.marginLeft = '10px';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { el.hidden = true; action.run(); });
    el.appendChild(btn);
  }
  el.classList.toggle('is-error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 5200 : 3600);
}

/**
 * 手工填写社团 / 艺术家的统一提示文案。
 * 后端一并返回：被自动套用的作品（propagated）与自动建立的同名标签（tag / tags）。
 */
function linkToastText(base, res = {}) {
  const n = (res.propagated ?? []).length;
  const tags = res.tags ?? (res.tag ? [res.tag] : []);
  const parts = [base];
  if (n) parts.push(`自动套用到 ${n} 张同名作品`);
  for (const t of tags) parts.push(`已打标签「${t.name}」`);
  if (!tags.length && res.tag_skipped) parts.push(`标签未建立：${res.tag_skipped}`);
  return parts.join('，');
}

/**
 * 手工填写社团 / 艺术家（含「采用建议的艺术家」）之后，**就地更新专辑墙缓存**。
 *
 * 为什么必须补：从专辑详情返回专辑墙走的是 `loadAlbums({ reuse: true })` —— 直接拿
 * `state.albums` 重新渲染，**不会重新请求**（这是为了保住滚动位置与分页）。
 * 所以只刷新标签栏而不补缓存的话，卡片封面下方的标签、名称下方的「[社团] · 艺术家」
 * 都会一直停在旧值，直到重启软件触发一次全量加载（v1.2.5 用户实测缺陷）。
 *
 * @param {Array<number|string>} ids 后端返回的 tagged_ids（本次填写的 + 库内同名自动套用的）
 * @param {{tag?:object, circle?:string, albumArtist?:string}} patch 要写回缓存的字段
 */
function patchAlbumCache(ids, { tag = null, circle, albumArtist } = {}) {
  if (!Array.isArray(ids) || !ids.length) return;
  const wanted = new Set(ids.map(Number));
  for (const row of state.albums ?? []) {
    if (!wanted.has(Number(row.id))) continue;
    if (circle !== undefined) row.circle = circle;
    if (albumArtist !== undefined) row.album_artist = albumArtist;
    if (tag?.id && !(row.tags ?? []).some((t) => Number(t.id) === Number(tag.id))) {
      row.tags = [...(row.tags ?? []), { id: tag.id, name: tag.name, color: tag.color }];
    }
  }
}

/**
 * 详情页改完标签后，把这张专辑的最新标签同步回专辑墙缓存。
 * 同样是因为返回专辑墙走 `loadAlbums({ reuse: true })`，不会重新请求。
 */
function syncWallTagsFromDetail() {
  if (state.view !== 'albumDetail') return;   // 在墙上改的标签，refreshCurrent 已经重新拉过列表
  const current = state.currentAlbum?.album;
  if (!current?.id) return;
  const row = (state.albums ?? []).find((a) => Number(a.id) === Number(current.id));
  if (row) row.tags = (current.tags ?? []).map((t) => ({ id: t.id, name: t.name, color: t.color }));
}

/* ------------------------------------------------------------------ 常量 */

const TAG_COLORS = ['#7d6cf5', '#43dfb8', '#f0b866', '#ff8fab', '#5aa9ff',
  '#c084fc', '#4ad991', '#ff9a76'];
const tagColor = (i) => TAG_COLORS[Number(i) % TAG_COLORS.length];

const MODE_META = {
  list: {
    label: '列表循环',
    svg: '<path d="M17 2l4 4-4 4"/><path d="M3 12V10a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 12v2a4 4 0 0 1-4 4H3"/>',
  },
  one: {
    label: '单曲循环',
    svg: '<path d="M17 2l4 4-4 4"/><path d="M3 12V10a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 12v2a4 4 0 0 1-4 4H3"/><path d="M11 10l1-1v6"/>',
  },
  shuffle: {
    label: '随机播放',
    svg: '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/>',
  },
  sequential: {
    label: '顺序播放',
    svg: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/><path d="M18 16v4"/><path d="M16 20h4"/>',
  },
};
const modeSvg = (mode) => `<svg viewBox="0 0 24 24">${MODE_META[mode].svg}</svg>`;
const MODE_ORDER = ['list', 'sequential', 'one', 'shuffle'];
const PAGE_SIZE = 60;

/* ------------------------------------------------------------------- 状态 */

const state = {
  view: 'albums',
  query: '',
  sort: localStorage.getItem('sort') || 'artist-asc',
  /**
   * 标签筛选：**专辑墙 / 喜欢的ASMR / 喜欢的专辑 三处各自独立**（v1.2.4）。
   *
   * 之前只有一个全局 Set：在专辑墙点了标签后，进收藏页依然生效，而且收藏页不显示
   * 标签栏、也看不到「正在筛选」，用户只能靠刷新或回专辑墙清除。
   */
  tagFilters: { wall: new Set(), favasmr: new Set(), favalbum: new Set() },
  /** 当前标签栏对应的是哪一套标签（music 普通 / voice ASMR），由视图或音乐库决定 */
  tagCatalogKind: 'music',
  tagMode: localStorage.getItem('tagMode') || 'and',
  albumSize: localStorage.getItem('albumSize') || 'medium',
  albums: [],
  albumTotal: 0,
  albumOffset: 0,
  hasMore: false,
  tagCatalog: [],
  /**
   * 标签栏里**已展开的分类**（`style` / `circle` / `artist`）。
   * 以前是一个全局布尔，点任意一栏的「＋ 还有 N 个」会把三栏一起展开；
   * 现在按分类独立记录，各栏互不影响。
   */
  tagBarExpanded: new Set(),
  libraries: [],
  trackList: [],
  tagsView: [],
  currentAlbum: null,
  /** 从专辑墙进详情页时的浏览进度快照（视图 + 滚动位置），供返回时还原 */
  wallSnapshot: null,
  /** 当前专辑的图片清单（图片预览栏目用；点缩略图时按下标取） */
  galleryImages: [],
  selecting: false,
  selected: new Set(),
  libraryFilter: null,
  /** 收藏范围：null=不筛收藏；'asmr'=喜欢的ASMR；'album'=喜欢的专辑 */
  favScope: null,
  /** 「喜欢的音乐」：只看被标记为喜欢的单曲 */
  trackFavOnly: false,
  playMode: localStorage.getItem('playMode') || 'list',
  queue: [],
  index: -1,
  history: [],
  shuffleOrder: [],
  shuffleCursor: -1,
  nowCover: null,
  queueLabel: '',
  lyrics: null,
  lyricsTrackId: null,
  lyricIndex: -1,
  userScrolling: false,
  followLyrics: localStorage.getItem('followLyrics') !== '0',
  scanTimer: null,
};

const audio = $('#audio');

/* ---------------------------------------------------------------- 音量 */
/**
 * 音量：0–100 与原来一致（直接给元素设 volume，1.0 = 数字满刻度），
 * 100 以上就是**软件放大** —— HTMLMediaElement.volume 规范上限就是 1，
 * 所以必须另接一层 Web Audio 的 GainNode 才能真正更响（用户要求扩到 200%）。
 *
 * 两个刻意的取舍：
 *   1. **懒接入**：只有真的用到 >100% 才创建音频图。没超过 100% 的用户走的还是原来那条路，
 *      不引入「AudioContext 被挂起 → 完全没声」这类新风险。
 *   2. **接上就一路走 gain**：一旦建了图，元素音量固定 1.0，音量全由 gain 决定，
 *      避免「元素音量 × 增益」两处叠加、换算关系说不清。
 *
 * 放大必然可能削顶，所以 100% 以上自动挂一个软限幅（DynamicsCompressor 当限制器用）：
 * 压住爆音，代价是轻微压缩动态。
 */
const VOLUME_MAX = 200;
const volumeState = {
  value: Number(localStorage.getItem('volume') ?? 85),
  graph: null,
  /** 成功接过音频图或接失败过，都不再重试（createMediaElementSource 一个元素只能接一次） */
  graphClaimed: false,
};

/** 建立「元素 → gain → 软限幅 → 输出」这条链路（只能建一次） */
function buildVolumeGraph() {
  if (volumeState.graphClaimed) return volumeState.graph;
  volumeState.graphClaimed = true;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('当前环境不支持 Web Audio');
    const ctx = new Ctx();
    const source = ctx.createMediaElementSource(audio);
    const gain = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    // 限制器参数：阈值贴着 0 dBFS、大比率、快启动，只当「安全阀」用
    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    source.connect(gain);
    gain.connect(limiter);
    limiter.connect(ctx.destination);
    volumeState.graph = { ctx, source, gain, limiter };
  } catch (err) {
    volumeState.graph = null;
    toast(`无法启用音量放大（${err.message}），最高仍为 100%`, true);
  }
  return volumeState.graph;
}

/**
 * 把音量（0–200）落到实际链路上；UI 文案与配色也在这里同步。
 *
 * @param {boolean} gesture 是否发生在用户手势里。**建音频图必须在手势里**：
 *   AudioContext 在非手势下会被自动播放策略挂起，而元素一旦接进这条图，
 *   挂起期间就是静音 —— 所以启动时读到 >100% 也只先按 100% 播，
 *   等用户第一次点/按键盘再补上放大（见 ensureVolumeGraphOnGesture）。
 */
function applyVolume(raw, { persist = true, gesture = false } = {}) {
  const value = Math.max(0, Math.min(VOLUME_MAX, Math.round(Number(raw) || 0)));
  volumeState.value = value;
  const ratio = value / 100;
  volumeState.pendingGraph = ratio > 1;

  if (ratio > 1 && (gesture || volumeState.graph)) buildVolumeGraph();

  if (volumeState.graph) {
    audio.volume = 1;
    volumeState.graph.gain.gain.value = ratio;
    volumeState.graph.limiter.threshold.value = ratio > 1 ? -1.5 : 0;
    try { void volumeState.graph.ctx.resume?.(); } catch { /* 忽略 */ }
  } else {
    audio.volume = Math.min(1, ratio);
  }

  const input = $('#volume');
  if (input && Number(input.value) !== value) input.value = String(value);
  const label = $('#volumeVal');
  if (label) label.textContent = `${value}%`;
  $('#volumeBox')?.classList.toggle('is-boost', value > 100);
  if (persist) localStorage.setItem('volume', String(value));
}

/** 首次真实交互时补建音频链路：上次退出前音量 >100% 的情况要等手势才接得上 */
function ensureVolumeGraphOnGesture() {
  if (!volumeState.pendingGraph || volumeState.graph) return;
  applyVolume(volumeState.value, { persist: false, gesture: true });
}
document.addEventListener('pointerdown', ensureVolumeGraphOnGesture, { capture: true });
document.addEventListener('keydown', ensureVolumeGraphOnGesture, { capture: true });

applyVolume(volumeState.value, { persist: false, gesture: false });

/* ==================================================== 封面缩略图（零依赖） */
/**
 * Hi-Res 库的内嵌封面常见 3000px / 数 MB，专辑墙一次渲染几十张会把内存吃满。
 * 方案：用浏览器原生 createImageBitmap(resizeWidth) 生成缩略图，存进 Cache Storage；
 * 第二次渲染起全部走小图。不引入任何图像处理依赖，也不改变服务端接口。
 */
const THUMB_CACHE = 'lam-thumbs-v1';
const THUMB_WIDTH = { small: 256, medium: 384, large: 512, row: 128 };
const thumbQueue = [];
const thumbObjectUrls = new Map();
let thumbRunning = false;

const thumbSupported = () => typeof caches !== 'undefined'
  && typeof createImageBitmap === 'function'
  && typeof OffscreenCanvas === 'function';

const thumbRequest = (hash, width) => new Request(`/__lam_thumb/${hash}-${width}`);

function thumbKeyOf(hash, width) {
  return `${hash}:${width}`;
}

/** 取缩略图 URL：命中缓存返回 blob URL，未命中先返回原图并排队生成 */
async function getThumbUrl(hash, originalUrl, width) {
  if (!hash || !thumbSupported()) return originalUrl;
  const key = thumbKeyOf(hash, width);
  if (thumbObjectUrls.has(key)) return thumbObjectUrls.get(key);
  try {
    const cache = await caches.open(THUMB_CACHE);
    const hit = await cache.match(thumbRequest(hash, width));
    if (hit) {
      const url = URL.createObjectURL(await hit.blob());
      thumbObjectUrls.set(key, url);
      return url;
    }
  } catch { /* 缓存不可用时退回原图 */ }
  enqueueThumb(hash, originalUrl, width);
  return originalUrl;
}

function enqueueThumb(hash, originalUrl, width) {
  if (thumbQueue.some((job) => job.hash === hash && job.width === width)) return;
  if (thumbObjectUrls.has(thumbKeyOf(hash, width))) return;
  thumbQueue.push({ hash, originalUrl, width });
  void pumpThumbs();
}

async function pumpThumbs() {
  if (thumbRunning) return;
  thumbRunning = true;
  try {
    while (thumbQueue.length) {
      const job = thumbQueue.shift();
      await generateThumb(job);
    }
  } finally {
    thumbRunning = false;
  }
}

async function generateThumb({ hash, originalUrl, width }) {
  try {
    const res = await fetch(originalUrl);
    if (!res.ok) return;
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeQuality: 'high' });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    const cache = await caches.open(THUMB_CACHE);
    await cache.put(thumbRequest(hash, width), new Response(out, {
      headers: { 'Content-Type': 'image/jpeg' },
    }));
    const url = URL.createObjectURL(out);
    thumbObjectUrls.set(thumbKeyOf(hash, width), url);
    swapCoverImages(hash, url);
  } catch { /* 生成失败就继续用原图 */ }
}

function swapCoverImages(hash, url) {
  $$(`img[data-cover-hash="${hash}"]`).forEach((img) => {
    if (img.dataset.thumbSwapped === '1') return;
    img.dataset.thumbSwapped = '1';
    const preload = new Image();
    preload.onload = () => { img.src = url; };
    preload.src = url;
  });
}

/* ------------------------------- 图片预览的缩略图（复用封面那套缓存/生成） */

/**
 * 画廊缩略图：**先在小尺寸上生成，再赋 src**。
 *
 * 与封面不同，这里不能「先显示原图再替换」—— 实测发行里单张预览图可到 21 MB
 * （RJ414024 的「高画質パッケージ.jpg」），一栏十几张原图解码会直接把内存拉满。
 * 因此首屏只留占位块，缩略图进视口时才生成（createImageBitmap 直接按目标宽度解码）。
 */
const GALLERY_THUMB_WIDTH = 360;
const galleryThumbUrls = new Map();
const galleryThumbPending = new Map();
let galleryThumbChain = Promise.resolve();

const galleryThumbRequest = (key, width) => new Request(`/__lam_gthumb/${key}-${width}`);
const galleryThumbKeyOf = (key, width) => `${key}:${width}`;

/** 生成并缓存一张画廊缩略图（同一 key 只跑一次，串行生成避免同时解码多张原图） */
function buildGalleryThumb(key, url, width) {
  const cacheKey = galleryThumbKeyOf(key, width);
  if (galleryThumbUrls.has(cacheKey)) return Promise.resolve(galleryThumbUrls.get(cacheKey));
  if (galleryThumbPending.has(cacheKey)) return galleryThumbPending.get(cacheKey);

  const job = galleryThumbChain.then(async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error('取图失败');
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeQuality: 'high' });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close?.();
    // PNG 可能带透明通道，转 JPEG 会变黑，这类原图仍按 PNG 输出
    const alpha = /\.(png|gif)$/i.test(url);
    const out = await canvas.convertToBlob(
      alpha ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.85 },
    );
    const cache = await caches.open(THUMB_CACHE);
    await cache.put(galleryThumbRequest(key, width), new Response(out, {
      headers: { 'Content-Type': out.type || 'image/jpeg' },
    }));
    const objectUrl = URL.createObjectURL(out);
    galleryThumbUrls.set(cacheKey, objectUrl);
    return objectUrl;
  }).catch(() => null).finally(() => galleryThumbPending.delete(cacheKey));

  galleryThumbPending.set(cacheKey, job);
  galleryThumbChain = job.then(() => undefined, () => undefined);
  return job;
}

/** 从缓存取；没有就生成。失败时返回原图 URL，保证「至少能看见」 */
async function galleryThumbUrl(key, originalUrl, width) {
  const cacheKey = galleryThumbKeyOf(key, width);
  if (galleryThumbUrls.has(cacheKey)) return galleryThumbUrls.get(cacheKey);
  try {
    const cache = await caches.open(THUMB_CACHE);
    const hit = await cache.match(galleryThumbRequest(key, width));
    if (hit) {
      const objectUrl = URL.createObjectURL(await hit.blob());
      galleryThumbUrls.set(cacheKey, objectUrl);
      return objectUrl;
    }
  } catch { /* 缓存不可用就现生成 */ }
  const built = await buildGalleryThumb(key, originalUrl, width);
  return built ?? originalUrl;
}

async function fillGalleryThumb(img) {
  const original = img.dataset.gallerySrc;
  const key = img.dataset.galleryKey;
  if (!original || img.dataset.galleryFilled === '1') return;
  img.dataset.galleryFilled = '1';
  if (!key || !thumbSupported()) { img.src = original; return; }
  const url = await galleryThumbUrl(key, original, GALLERY_THUMB_WIDTH);
  img.src = url;
}

/** 只给「进入视口附近」的缩略图生成，长画廊不会一次性解码全部原图 */
function hydrateGalleryThumbs(root = document) {
  const images = $$('img[data-gallery-src]', root);
  if (!images.length) return;
  if (typeof IntersectionObserver !== 'function') {
    images.forEach((img) => { void fillGalleryThumb(img); });
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      void fillGalleryThumb(entry.target);
    }
  }, { rootMargin: '400px 0px' });
  images.forEach((img) => observer.observe(img));
}

/** 渲染后决定每张封面加载缩略图还是原图（异步、不阻塞首屏） */
async function hydrateCoverThumbs(root = document) {  if (!thumbSupported()) {
    $$('img[data-cover-src]', root).forEach((img) => {
      if (!img.getAttribute('src')) img.src = img.dataset.coverSrc;
    });
    return;
  }
  const width = THUMB_WIDTH[state.albumSize] ?? THUMB_WIDTH.medium;
  const images = $$('img[data-cover-src]', root);
  for (const img of images) {
    if (img.getAttribute('src')) continue;
    const hash = img.dataset.coverHash;
    const original = img.dataset.coverSrc;
    if (!hash) { img.src = original; continue; }
    const url = await getThumbUrl(hash, original, width);
    img.src = url;
    if (url !== original) img.dataset.thumbSwapped = '1';
  }
}

/** 供统计页展示缓存占用 */
async function thumbCacheStats() {
  if (!thumbSupported()) return null;
  try {
    const cache = await caches.open(THUMB_CACHE);
    const keys = await cache.keys();
    return { count: keys.length };
  } catch {
    return null;
  }
}

/* ============================================================ 视图：专辑墙 */

/**
 * 封面占位层 + 图片。eager=true 时直接加载原图（详情页/正在播放页需要高分辨率）；
 * 否则先不设 src，由 hydrateCoverThumbs 决定加载缩略图还是原图 ——
 * 这样重复访问时永远不会去取那张几 MB 的大图。
 */
/**
 * 详情页封面。有封面时可点击看原图（复用图片预览的浮层），
 * 因此渲染成 button，样式由 .detail-cover.is-zoomable 抹平。
 */
function detailCoverMarkup(album) {
  const inner = coverMarkup(album.cover_url, album.album, album.cover_hash, { eager: true });
  if (!album.cover_url) return `<div class="detail-cover">${inner}</div>`;
  return `<button type="button" class="detail-cover is-zoomable" data-cover-zoom
            data-cover-url="${esc(album.cover_url)}" title="点击查看完整封面原图">
            ${inner}
          </button>`;
}

/**
 * 专辑详情页里与压缩包缓存相关的按钮（仅包内曲目存在时出现）：
 * 「预读专辑」把整张解码进缓存，「清除缓存」只清这一张。
 */
function archiveCacheButtons(album) {
  if (!(Number(album.archive?.tracks) > 0)) return '';
  return `
    <button class="btn" id="prefetchAlbumBtn" title="把该专辑包内曲目一次性解码到缓存，之后播放无需等待">⤓ 预读专辑</button>
    <button class="btn" id="clearAlbumCacheBtn" title="只清除这一张专辑的缓存，不影响其它专辑">🧹 清除缓存</button>`;
}

function coverMarkup(url, name, hash = null, { eager = false } = {}) {
  const initial = esc((name ?? '?').trim().charAt(0).toUpperCase() || '?');
  if (!url) return `<div class="placeholder">${initial}</div>`;
  const src = eager ? `src="${esc(url)}"` : '';
  return `<div class="placeholder">${initial}</div>
          <img ${src} alt="" loading="lazy"
               data-cover-hash="${esc(hash ?? '')}" data-cover-src="${esc(url)}"
               onerror="this.remove()">`;
}

function badgesFor(album) {
  const parts = [];
  // 音声发行：版本数 / 特典 / 视频版
  if (album.is_voice) {
    if (album.version_count > 0) {
      parts.push(`<span class="badge is-voice" title="这一发行包含 ${album.version_count} 个可播放版本">`
        + `${album.version_count} 个版本</span>`);
    }
    if (album.has_bonus) parts.push('<span class="badge is-bonus" title="包含特典轨道">含特典</span>');
    if (album.has_video) parts.push('<span class="badge is-video" title="部分轨道有视频版">含视频版</span>');
  }
  // 压缩包只读挂载：来源提示（专辑墙保留「包内」角标）
  const arch = album.archive;
  if (arch?.archives > 0) {
    parts.push(`<span class="badge is-archive" title="该发行来自压缩包：${arch.tracks} 条曲目在包内，播放时会按需解码">`
      + `🗜 包内 ${arch.tracks}</span>`);
  }
  /*
   * v1.2.5 起**不再提示信息缺失**（用户要求）：卡片上不再出现
   * 「⚠ 待完善 / ⚠ 关键缺失」角标，也不再有左侧「待完善」分类。
   * 缺失字段本身的编辑能力保留（编辑信息 / 填写社团 / 填写艺术家等）。
   */
  if (album.tags?.length) {
    parts.push(`<span class="badge is-tag">🏷 ${album.tags.length}</span>`);
  }
  return parts.length ? `<div class="badges">${parts.join('')}</div>` : '';
}

function albumCardMarkup(a) {
  const sub = [a.year || null, `${a.track_count} 首`, a.disc_count > 1 ? `${a.disc_count} 碟` : null]
    .filter(Boolean).join(' · ');
  const tags = (a.tags ?? []).slice(0, 3).map((t) =>
    `<span class="mini-tag" style="color:${tagColor(t.color)}">${esc(t.name)}</span>`).join('');
  const more = (a.tags?.length ?? 0) > 3 ? `<span class="mini-tag">+${a.tags.length - 3}</span>` : '';
  return `
    <article class="album-card" data-id="${a.id}">
      <div class="album-cover">
        <button class="fav-btn${a.favorite ? ' is-on' : ''}" data-fav="${a.id}"
          title="${a.favorite ? '取消喜欢' : '标记为喜欢'}" aria-pressed="${a.favorite ? 'true' : 'false'}">
          <svg viewBox="0 0 24 24"><path d="M12 20.5 4.2 13a4.8 4.8 0 0 1 6.8-6.8l1 1 1-1A4.8 4.8 0 0 1 19.8 13z"/></svg>
        </button>
        ${badgesFor(a)}
        <span class="select-mark">✓</span>
        ${coverMarkup(a.cover_url, a.album, a.cover_hash)}
        <div class="overlay">
          <button class="mini-edit" data-edit="${a.id}" title="编辑信息">
            <svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
          </button>
          <button class="mini-play" data-play="${a.id}" title="播放整张专辑">
            <svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>
          </button>
        </div>
      </div>
      <div class="album-meta">
        <div class="album-name">${esc(a.album)}</div>
        ${creditLine(a)}
        <div class="album-sub">${esc(sub)}</div>
        ${tags || more ? `<div class="album-tags">${tags}${more}</div>` : ''}
      </div>
    </article>`;
}

/**
 * 专辑名称下方的署名行：有社团时显示「[社团] · 艺术家」，否则只显示艺术家。
 * 未知艺术家不重复占位。
 */
function creditLine(a) {
  const circle = String(a.circle ?? '').trim();
  const artist = String(a.album_artist ?? '').trim();
  const artistKnown = artist && artist !== '(未知艺术家)';
  if (!circle && !artistKnown) return '';
  const parts = [];
  if (circle) parts.push(`[${esc(circle)}]`);
  if (artistKnown) parts.push(esc(artist));
  return `<div class="album-credit">${parts.join(' · ')}</div>`;
}

/** 当前视图的标签筛选集合 —— 三处互相独立（专辑墙 / 喜欢的ASMR / 喜欢的专辑） */
function activeTagFilter() {
  if (state.view === 'favasmr') return state.tagFilters.favasmr;
  if (state.view === 'favalbum') return state.tagFilters.favalbum;
  return state.tagFilters.wall;
}

/** 当前选中的音乐库类别：决定专辑墙显示哪一套标签 */
function currentLibraryKind() {
  const lib = state.libraries?.find((l) => String(l.id) === String(state.libraryFilter));
  return lib?.kind === 'voice' ? 'voice' : 'music';
}

/**
 * 当前视图该用哪一套标签：
 *   · 喜欢的ASMR → voice；喜欢的专辑 → music
 *   · 专辑墙 → 跟随所选音乐库的类别（ASMR 库显示 ASMR 那套，普通库显示普通那套）
 */
function tagKindForView() {
  if (state.view === 'favasmr') return 'voice';
  if (state.view === 'favalbum') return 'music';
  return currentLibraryKind();
}

function albumQuery(offset) {
  const params = new URLSearchParams({
    q: state.query,
    sort: state.sort,
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  const filter = activeTagFilter();
  if (filter.size) {
    params.set('tags', [...filter].join(','));
    params.set('tagMode', state.tagMode);
  }
  if (state.favScope) {
    params.set('favorite', '1');
    params.set('kind', state.favScope === 'asmr' ? 'voice' : 'music');
  }
  // 专辑墙**必须**带一个音乐库；收藏视图是跨库的，不带库筛选
  if (!state.favScope && state.libraryFilter) params.set('libraryId', String(state.libraryFilter));
  return `/api/albums?${params}`;
}

async function loadAlbums({ append = false, reuse = false } = {}) {
  // reuse：从专辑详情返回时**沿用已加载的列表**，不重新请求，配合 route() 还原滚动位置
  if (!reuse) {
    const offset = append ? state.albumOffset : 0;
    const { albums, total, hasMore } = await api(albumQuery(offset));
    state.albums = append ? [...state.albums, ...albums] : albums;
    state.albumTotal = total;
    state.albumOffset = state.albums.length;
    state.hasMore = hasMore;
  }
  const total = state.albumTotal;

  $('#albumGrid').className = `album-grid size-${state.albumSize}`;
  $('#albumGrid').innerHTML = state.albums.map(albumCardMarkup).join('');
  // 明确告诉用户当前筛选条件（音乐库是必选项，不再有「全部库」）
  const libName = state.libraryFilter
    ? state.libraries?.find((l) => String(l.id) === String(state.libraryFilter))?.display_name
    : null;
  const tagFilter = activeTagFilter();
  const parts = [];
  if (state.favScope === 'asmr') parts.push('喜欢的ASMR');
  if (state.favScope === 'album') parts.push('喜欢的专辑');
  if (libName && !state.favScope) parts.push(`${libName} 库`);
  if (state.query) parts.push(`搜索「${state.query}」`);
  if (tagFilter.size) parts.push('标签筛选');
  $('#resultCount').textContent = parts.length
    ? `${parts.join(' · ')}：${total} 张专辑`
    : `${total} 张专辑`;

  // 专辑墙没有选中音乐库时，空库提示要指向「添加/选择音乐库」而不是「换关键词」
  const noLibrary = !state.favScope && !state.libraryFilter;
  const filtered = Boolean(state.query || tagFilter.size || state.libraryFilter || state.favScope);
  const empty = state.albums.length === 0;
  $('#albumsEmpty').hidden = !empty;
  if (empty) {
    if (noLibrary) {
      $('#emptyTitle').textContent = '请先选择音乐库';
      $('#emptyText').textContent = '在左侧「音乐库」里点选一个目录，专辑墙只显示该库的专辑。';
    } else {
      $('#emptyTitle').textContent = filtered ? '没有匹配的专辑' : '还没有音乐';
      $('#emptyText').textContent = filtered
        ? '换个关键词，或清除筛选后重试。'
        : '在左侧添加一个音乐目录，然后点击「扫描音乐库」。';
    }
  }
  $('#loadMoreWrap').hidden = !state.hasMore;
  if (state.hasMore) {
    $('#loadMoreBtn').textContent = `加载更多（已显示 ${state.albums.length} / 共 ${total}）`;
  }
  syncSelectionUi();
  void hydrateCoverThumbs($('#albumGrid'));
}

/* ------------------------------------------------------------ 标签筛选条 */

/**
 * 标签三大分类（与后端 tags.mjs 的 TAG_CATEGORIES 对应）。
 * 专辑墙上方按「风格 / 社团 / CV」分栏，便于直接点标签筛选。
 */
const TAG_CATEGORY_META = [
  { key: 'style', label: '风格', hint: '曲风、氛围、玩法等自建标签' },
  { key: 'circle', label: '社团', hint: '填写社团时自动建立' },
  { key: 'artist', label: 'CV', hint: '填写艺术家时自动建立' },
];
const TAG_CATEGORY_LABEL = Object.fromEntries(TAG_CATEGORY_META.map((c) => [c.key, c.label]));
const TAG_CATEGORY_ORDER = TAG_CATEGORY_META.map((c) => c.key);

/**
 * 两套标签（与后端 tags.mjs 的 TAG_KINDS 对应）。
 * 专辑墙显示哪一套由**当前音乐库的类别**决定；两个收藏页各自固定一套。
 */
const TAG_KIND_META = [
  { key: 'music', label: '普通专辑', hint: '只在普通音乐专辑上可用' },
  { key: 'voice', label: 'ASMR', hint: '只在音声（ASMR）发行上可用' },
];

/**
 * 把标签按分类分桶；未知分类一律归入「风格」。
 *
 * 栏内顺序（v1.2.4）：
 *   ① `lead` 标签（后端 tags.mjs 的 LEAD_TAG_NAMES，「已预读」）**固定最前**
 *   ② 当前已选中的标签（点了筛选就挪到前面，避免选完又被「＋ 还有 N 个」折叠掉）
 *   ③ 其余标签保持后端给的原始顺序
 * 取消选中时会重新按原始顺序渲染，因此自动**还原到原来的位置**。
 */
function groupTagsByCategory(tags, selected = null) {
  const map = new Map(TAG_CATEGORY_ORDER.map((k) => [k, []]));
  for (const t of tags ?? []) {
    const key = TAG_CATEGORY_LABEL[t.category] ? t.category : 'style';
    map.get(key).push(t);
  }
  for (const [key, list] of map) {
    const lead = list.filter((t) => t.lead === true);
    const rest = list.filter((t) => t.lead !== true);
    const picked = selected ? rest.filter((t) => selected.has(t.id)) : [];
    const others = selected ? rest.filter((t) => !selected.has(t.id)) : rest;
    map.set(key, [...lead, ...picked, ...others]);
  }
  return map;
}

async function loadTagBar() {
  /*
   * 标签栏取哪一套标签由**当前选中的音乐库类别**决定（普通 / ASMR）。
   * 库列表已经拿到、却还没定下当前库时先补一个默认库：扫描完成、首次添加音乐库
   * 这些时机里，选择逻辑可能晚于标签栏刷新（v1.2.5 用户实测：初次扫描 ASMR 库后
   * 标签识别出来了，但标签栏里一个都不显示，重启才正常）。
   */
  if (!state.libraryFilter && (state.libraries?.length ?? 0) > 0) ensureDefaultLibrary();
  const kind = tagKindForView();
  const { tags } = await api(`/api/tags?kind=${kind}`);
  state.tagCatalog = tags;
  state.tagCatalogKind = kind;
  renderTagBar();
}

function tagChipMarkup(t) {
  return `
    <button class="tag-chip tagbar-chip ${activeTagFilter().has(t.id) ? 'is-active' : ''}" data-tag="${t.id}">
      <span class="tag-dot" style="background:${tagColor(t.color)}"></span>
      ${esc(t.name)}<span class="tag-count">${t.album_count}</span>
    </button>`;
}

/**
 * 折叠状态：每一栏只保留**第一行**放得下的 chip，其余隐藏。
 *
 * 隐藏的 chip 不占位，因此「＋ 还有 N 个」会自然落到第一行末尾。
 * 若这个按钮本身被挤到第二行，就让出末尾的 chip，直到它也回到第一行为止。
 */
function collapseTagRowToFirstLine(box) {
  const chips = [...box.querySelectorAll('.tagbar-chip')];
  const more = box.querySelector('[data-more]');
  if (!more || chips.length < 2) return;

  for (const c of chips) c.hidden = false;
  more.hidden = false;

  const lineTop = chips[0].offsetTop;
  for (const c of chips.slice(1)) {
    if (c.offsetTop !== lineTop) c.hidden = true;
  }
  const hiddenCount = () => chips.filter((c) => c.hidden).length;
  if (!hiddenCount()) { more.hidden = true; return; } // 一行就放得下，无需按钮

  more.textContent = `＋ 还有 ${hiddenCount()} 个`;
  let guard = 0;
  while (more.offsetTop !== lineTop && guard < 5) {
    const visible = chips.filter((c) => !c.hidden);
    if (!visible.length) break;
    visible[visible.length - 1].hidden = true;
    more.textContent = `＋ 还有 ${hiddenCount()} 个`;
    guard += 1;
  }
}

function renderTagBar() {
  const bar = $('#tagBar');
  // 三个专辑墙视图（专辑墙 / 喜欢的ASMR / 喜欢的专辑）都要显示标签栏，各自独立筛选
  bar.hidden = !ALBUM_WALL_VIEWS.includes(state.view);

  const filter = activeTagFilter();
  const byCategory = groupTagsByCategory(state.tagCatalog, filter);
  const kindLabel = state.tagCatalogKind === 'voice' ? 'ASMR' : '普通专辑';

  const sizes = ['small', 'medium', 'large'];
  const sizeLabels = { small: '小', medium: '中', large: '大' };

  const head = `
    <div class="tagbar-head">
      ${filter.size ? '<button class="tag-chip is-clear" data-clear="1">✕ 清除筛选</button>' : ''}
      <span class="tagbar-title">标签筛选</span>
      <span class="tagbar-kind" title="两套标签相互独立：ASMR 与普通专辑各有一套">${kindLabel}</span>
      <span style="flex:1"></span>
      <span class="tag-count">封面</span>
      ${sizes.map((s) => `<button class="tag-chip ${state.albumSize === s ? 'is-active' : ''}"
         data-size="${s}">${sizeLabels[s]}</button>`).join('')}
    </div>`;

  const rows = TAG_CATEGORY_META.map(({ key, label, hint }) => {
    const all = byCategory.get(key) ?? [];
    if (!all.length) return '';
    // 折叠态：先按原样渲染，插入 DOM 后再量出第一行能放几个（见 collapseTagRowToFirstLine）
    // 展开态**按分类独立**记录，点哪栏的「还有 N 个」只展开哪栏
    const expanded = state.tagBarExpanded.has(key);
    const tail = expanded
      ? (all.length > 1 ? `<button class="tag-chip is-more" data-less="1" data-cat="${key}">收起</button>` : '')
      : `<button class="tag-chip is-more" data-more="1" data-cat="${key}" hidden>＋ 还有 0 个</button>`;
    return `
      <div class="tagbar-row" data-cat-row="${key}">
        <span class="tagbar-label" title="${esc(hint)}">${label}<em>${all.length}</em></span>
        <div class="tagbar-chips">${all.map(tagChipMarkup).join('')}${tail}</div>
      </div>`;
  }).join('');

  const emptyRow = `
    <div class="tagbar-row">
      <span class="tagbar-label">标签</span>
      <div class="tagbar-chips">
        <span class="tag-count">还没有标签 —— 在专辑卡片或详情页点「🏷」即可创建</span>
      </div>
    </div>`;

  bar.innerHTML = head + (state.tagCatalog.length ? rows : emptyRow);

  /**
   * 展开态给标签栏加一个上限（CSS `.tagbar.is-expanded`：33vh + 滚动）。
   * 展开的栏多、标签多时，不让标签栏把专辑墙挤没；折叠态保持自然高度。
   */
  bar.classList.toggle('is-expanded', state.tagBarExpanded.size > 0);

  // 隐藏状态下量不出真实行高，等回到专辑墙（showView → renderTagBar）再量
  if (!bar.hidden) {
    for (const box of $$('#tagBar .tagbar-chips')) {
      const cat = box.closest('.tagbar-row')?.dataset.catRow;
      if (state.tagBarExpanded.has(cat)) continue;   // 展开的那栏整行铺开，不做折叠
      collapseTagRowToFirstLine(box);
    }
  }
}

/* ========================================================== 视图：专辑详情 */

/** 音声发行的轨道行：一条轨道 + 可切换的版本 chips */
function voiceTrackRowMarkup(row, index) {
  const chips = row.variants.map((v) => {
    const isVideo = v.file_kind === 'video';
    // 音频：若该文件带更具体的差分标记（如「无音效 无饮尿」），用它替代版本名，
    // 避免同一版本下出现两个同名 chip
    const baseName = v.variant_label && !isVideo ? v.variant_label : v.version_name;
    const label = isVideo
      ? `视频版${v.variant_label ? `·${esc(v.variant_label)}` : ''}`
      : esc(baseName);
    const active = v.track_id === row.preferred_track_id ? ' is-active' : '';
    // 压缩包来源只留数据标记，**不在单曲 chip 上显示「包内」**（用户要求：
    // 来源信息统一由专辑墙角标与详情页说明条承担，曲目行保持干净）
    const fromArchive = v.source_kind === 'archive_member';
    // 仍需先解码的才弹预读取询问；已缓存的直接播
    const needPrefetch = v.needs_prefetch === true;
    const tip = isVideo
      ? `${esc(v.version_name)}${v.variant_label ? ` · ${esc(v.variant_label)}` : ''}`
      : `${esc(v.version_name)}${v.variant_label ? ` · ${esc(v.variant_label)}` : ''}`;
    return `<button type="button" class="ver-chip${active}${isVideo ? ' is-video' : ''}"
        data-track="${v.track_id}" data-kind="${v.file_kind}" data-label="${label}"
        ${fromArchive ? ' data-from-archive="1"' : ''}
        ${needPrefetch ? ' data-need-prefetch="1"' : ''}
        title="${tip} (${esc(v.ext ?? '')})">
        ${isVideo ? '▶ ' : ''}${label}
      </button>`;
  }).join('');

  return `
    <div class="track-row voice-row" data-row="${esc(row.key)}">
      <div class="t-num">${row.track_no ?? index + 1}</div>
      <div class="t-title">
        ${esc(row.title)}
        ${row.conflict ? '<span class="row-warn" title="文件名与文件夹版本标识不一致，请人工确认">⚠</span>' : ''}
      </div>
      <div class="ver-chips">${chips}</div>
      <div class="t-time">${row.variants.length > 1 ? `${row.variants.length} 个版本` : ''}</div>
    </div>`;
}

/** 音声发行详情：版本列表 + 按轨号合并的轨道行 + 特典分组 + 问题面板 */
/** 音声发行详情：版本列表 + 按轨号合并的轨道行 + 特典分组 + 问题面板 + 图片预览 */
function voiceDetailMarkup(album, data, gallery = null) {
  const versions = data.versions ?? [];
  const bonus = data.bonus_tracks ?? [];
  const mainCount = data.tracks?.length ?? 0;

  const versionChips = versions.map((v) => `<span class="ver-pill${v.group_kind === 'bonus' ? ' is-bonus' : ''}"
      title="${v.track_count} 条轨道 · 播放用 ${esc(v.preferred_format ?? '')} · ${fmtBytes(v.total_bytes)}">
      ${esc(v.name)}<em>${v.preferred_format ?? ''}</em></span>`).join('');

  const rowsHtml = (data.tracks ?? []).map((r, i) => voiceTrackRowMarkup(r, i)).join('');
  const bonusHtml = bonus.length
    ? `<details class="bonus-box">
        <summary>特典（${bonus.length} 条）</summary>
        <div class="track-table">${bonus.map((r, i) => voiceTrackRowMarkup(r, i)).join('')}</div>
      </details>`
    : '';

  return `
    <div class="detail-head">
      ${detailCoverMarkup(album)}
      <div class="detail-info">
        <div class="detail-kind">音声发行　RJ 号 <button class="rj-code" id="rjCopyBtn"
          title="点击复制">${esc(album.rj_code ?? '—')}</button></div>
        <h1 class="detail-title">${esc(album.album)}</h1>
        <div class="detail-artist">
          <span class="credit-item"><span class="credit-label">艺术家：</span>${esc(album.album_artist)}</span>
          <span class="credit-item"><span class="credit-label">社团：</span>${esc(album.circle || '—')}</span>
          ${album.artist_source === 'tag'
    ? '<span class="src-hint" title="这个艺术家来自音频文件的标签，可能不准确，可点击「填艺术家」更正">来自文件标签</span>' : ''}
          <button class="btn btn-mini" id="voiceArtistBtn" title="仅记录在软件内，不写回文件">填艺术家</button>
          <button class="btn btn-mini" id="voiceCircleBtn" title="仅记录在软件内，不写回文件">填写社团</button>
        </div>
        ${album.artist_suggested ? `
        <div class="src-warn">
          <span>⚠ 文件标签里的专辑艺术家是「<b>${esc(album.artist_suggested)}</b>」，
            与曲目艺术家不一致。<b>已按曲目艺术家显示</b>，你可以选择采用标签值，或保持现状。</span>
          <button class="btn btn-mini" id="adoptArtistBtn">采用它</button>
          <button class="btn btn-mini" id="keepArtistBtn">保持现状</button>
        </div>` : ''}
        <div class="detail-meta">
          ${[`${versions.length} 个版本`, `${mainCount} 条轨道${bonus.length ? ` + ${bonus.length} 条特典` : ''}`,
    `${album.track_count} 个文件`].join(' · ')}
        </div>
        <div class="detail-actions">
          <button class="btn btn-primary" id="playAlbumBtn">
            <svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg> 播放本版本
          </button>
          <button class="btn" id="tagAlbumBtn">🏷 标签</button>
          <button class="btn" id="editVoiceMediaBtn" title="写回磁盘音频文件的标签/封面；压缩包内只读">
            <svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg> 编辑媒体
          </button>
          <button class="btn" id="revealAlbumBtn">
            <svg viewBox="0 0 24 24"><path d="M3 7h5l2 2h11v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg> 打开文件夹
          </button>
          ${archiveCacheButtons(album)}
          <button class="btn" id="voiceIssuesBtn">⚠ 检查问题</button>
        </div>
        <div class="wb-missing" style="margin-top:14px" id="detailTags">
          ${album.tags?.length
    ? album.tags.map((t) => `<span class="tag-pill is-preset" style="--tag-color:${tagColor(t.color)}">${esc(t.name)}</span>`).join('')
    : '<span class="tag-count">还没有标签</span>'}
        </div>
        <div class="voice-notes">音声专辑的名称取自文件夹；艺术家/社团的快捷填写只记库内。点「编辑媒体」可显式写回<b>磁盘文件</b>的标签/封面；<b>压缩包内文件只读</b>。</div>
        ${album.archive?.archives > 0 ? `<div class="voice-notes archive-note">
          🗜 该发行来自压缩包：<b>${album.archive.tracks} 条曲目在包内</b>（已按包内目录结构解析版本与轨号）。
          包内文件不会被修改，播放时会按需解码到缓存。
        </div>` : ''}
      </div>
    </div>

    <div class="voice-versions">
      <div class="voice-section-title">版本（${versions.length}）</div>
      <div class="ver-pills">${versionChips || '<span class="tag-count">未识别到版本</span>'}</div>
    </div>

    <div id="voiceIssuesBox"></div>

    <div class="track-table" id="voiceTrackTable">
      <div class="track-row is-head voice-row">
        <div class="t-num">#</div><div>标题</div><div>版本</div><div class="t-time"></div>
      </div>
      ${rowsHtml || '<div class="tag-count" style="padding:16px">没有可播放的轨道</div>'}
    </div>
    ${bonusHtml}
    ${imageGalleryMarkup(gallery, album.id)}`;
}

/* ==================================================== 图片预览（专辑内图片） */

/**
 * 图片预览栏目：按图片所在文件夹分组，点缩略图看原图。
 * 数据来自 `/api/albums/:id/images`（音声发行看 release_root，压缩包同样支持）。
 */
function imageGalleryMarkup(gallery, albumId = 'a') {
  const images = gallery?.images ?? [];
  if (!images.length) return '';
  const groups = gallery.groups?.length
    ? gallery.groups
    : [{ label: '图片', indices: images.map((i) => i.index) }];

  const body = groups.map((g) => `
    <div class="gallery-group">
      <div class="gallery-group-head">
        ${esc(g.label)}<span class="tag-count">${g.indices.length}</span>
      </div>
      <div class="gallery-grid">
        ${g.indices.map((i) => {
    const img = images[i];
    if (!img) return '';
    // 不直接给 src：先留占位，缩略图进视口时才生成（见 fillGalleryThumb）
    return `<button type="button" class="gallery-thumb" data-gallery-index="${img.index}"
              title="${esc(img.name)}（点击看原图）">
              <img data-gallery-src="${esc(img.url)}"
                   data-gallery-key="g${albumId}-${img.index}-${img.size ?? 0}"
                   alt="${esc(img.name)}" />
            </button>`;
  }).join('')}
      </div>
    </div>`).join('');

  return `
    <details class="image-gallery" open>
      <summary>图片预览<span class="tag-count">${images.length} 张${
  gallery.source === 'archive' ? ' · 压缩包内' : ''}</span></summary>
      ${gallery.truncated ? '<div class="tag-count">图片较多，这里只列出前一部分</div>' : ''}
      ${body}
    </details>`;
}

/** 看原图：单例浮层，← → 切换、ESC 关闭、点背景关闭 */
const lightboxState = { images: [], index: 0 };

function renderLightbox() {
  const { images, index } = lightboxState;
  const img = images[index];
  if (!img) { closeLightbox(); return; }
  $('#lightboxImg').src = img.url;
  $('#lightboxImg').alt = img.name;
  $('#lightboxCaption').textContent =
    `${index + 1} / ${images.length}${img.group ? ` · ${img.group}` : ''} · ${img.name}`;
  const single = images.length < 2;
  $('#lightboxPrev').disabled = single;
  $('#lightboxNext').disabled = single;
}

function openLightbox(images, index) {
  if (!images?.length) return;
  lightboxState.images = images;
  lightboxState.index = Math.max(0, Math.min(Number(index) || 0, images.length - 1));
  renderLightbox();
  $('#lightbox').hidden = false;
}

function stepLightbox(delta) {
  const n = lightboxState.images.length;
  if (n < 2) return;
  lightboxState.index = (lightboxState.index + delta + n) % n;
  renderLightbox();
}

function closeLightbox() {
  $('#lightbox').hidden = true;
  $('#lightboxImg').removeAttribute('src');
  lightboxState.images = [];
  lightboxState.index = 0;
}

async function openAlbum(id, { push = true } = {}) {
  /**
   * 从专辑墙进详情页前记下浏览进度（视图 + 滚动位置 + **当时的查询条件**）。
   * 返回时 route() 会用这份快照原地还原，见 state.wallSnapshot。
   *
   * 记下查询条件很关键：只有筛选/搜索完全没变时，「复用旧列表」才等价于「重新拉取」；
   * 否则会把旧条件下的列表拿来糊弄新条件（例如在详情页改了搜索词，返回后看到的是旧结果）。
   */
  if (ALBUM_WALL_VIEWS.includes(state.view)) {
    state.wallSnapshot = {
      view: state.view,
      scrollTop: $('#viewAlbums')?.scrollTop ?? 0,
      query: albumQuery(0),
    };
  }

  // 图片清单与专辑数据并行取；画廊失败不该拖垮详情页
  const [data, gallery] = await Promise.all([
    api(`/api/albums/${encodeURIComponent(id)}`),
    api(`/api/albums/${encodeURIComponent(id)}/images`).catch(() => null),
  ]);
  const { album, tracks } = data;
  state.galleryImages = gallery?.images ?? [];

  // 音声发行走专用渲染（版本切换 + 特典分组 + 问题面板）
  if (album.is_voice) return openVoiceAlbum(data, { push, gallery });

  state.currentAlbum = { album, tracks };

  const total = tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);
  const formats = [...new Set(tracks.map((t) => (t.ext ?? '').replace('.', '').toUpperCase()).filter(Boolean))];
  const bitrates = tracks.map((t) => t.bitrate).filter(Number.isFinite);
  const avgKbps = bitrates.length ? Math.round(bitrates.reduce((a, b) => a + b, 0) / bitrates.length / 1000) : null;

  const tagsHtml = album.tags?.length
    ? album.tags.map((t) => `<span class="tag-pill is-preset" style="--tag-color:${tagColor(t.color)}">${esc(t.name)}</span>`).join('')
    : '<span class="tag-count">还没有标签</span>';

  $('#albumDetail').innerHTML = `
    <div class="detail-head">
      ${detailCoverMarkup(album)}
      <div class="detail-info">
        <div class="detail-kind">专辑</div>
        <h1 class="detail-title">${esc(album.album)}</h1>
        <div class="detail-artist">
          <span class="credit-item"><span class="credit-label">艺术家：</span>${esc(album.album_artist)}</span>
          <span class="credit-item"><span class="credit-label">社团：</span>${esc(album.circle || '—')}</span>
        </div>
        <div class="detail-meta">
          ${[album.year || null, album.genre || null, `${tracks.length} 首曲目`, fmtLong(total)]
            .filter(Boolean).map(esc).join(' · ')}
          ${avgKbps ? ` · 平均 ${avgKbps} kbps` : ''}
          ${formats.length ? ` · ${esc(formats.join(' / '))}` : ''}
        </div>
        <div class="detail-actions">
          <button class="btn btn-primary" id="playAlbumBtn">
            <svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg> 播放专辑
          </button>
          <button class="btn" id="tagAlbumBtn">🏷 标签</button>
          <button class="btn" id="editAlbumBtn">
            <svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg> 编辑信息
          </button>
          <button class="btn" id="circleBtn" title="仅记录在软件内，不写回文件">填写社团</button>
          ${archiveCacheButtons(album)}
          <button class="btn" id="revealAlbumBtn">
            <svg viewBox="0 0 24 24"><path d="M3 7h5l2 2h11v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg> 打开文件夹
          </button>
        </div>
        <div class="wb-missing" style="margin-top:14px" id="detailTags">${tagsHtml}</div>
      </div>
    </div>
    <div class="track-table">
      ${trackTableHeader('艺术家')}
      ${tracks.map((t, i) => trackRowMarkup(t, i, { showAlbum: false })).join('')}
    </div>
    ${imageGalleryMarkup(gallery, album.id)}`;

  hydrateGalleryThumbs($('#albumDetail'));
  $('#playAlbumBtn').addEventListener('click', () => playQueue(tracks, 0, {
    cover: album.cover_url, label: `专辑《${album.album}》`,
  }));
  $('#tagAlbumBtn').addEventListener('click', () => openTagDialog([album.id], album.tags ?? []));
  $('#editAlbumBtn').addEventListener('click', () => openEditDrawer(album.id));
  $('#circleBtn')?.addEventListener('click', async () => {
    const name = await askText({
      title: '填写社团',
      hint: '仅记录在软件内，可作为检索依据，不会写回音频文件',
      value: album.circle ?? '',
      placeholder: '例如 上海飯店',
    });
    if (name === null) return;
    const res = await api(`/api/albums/${album.id}/circle`, { method: 'POST', body: { circle: name } });
    toast(linkToastText('已保存社团（仅库内记录）', res));
    await loadTagBar(); // 自动建立的同名标签要立刻出现在专辑墙上方的「社团」栏
    openAlbum(album.id, { push: false });
  });
  $('#revealAlbumBtn').addEventListener('click', () => {
    api('/api/reveal', { method: 'POST', body: { path: tracks[0]?.path } }).catch(() => {});
  });
  bindDetailCacheActions(album);

  showView('albumDetail');
  if (push) history.pushState({ id }, '', `#/album/${id}`);
  highlightPlayingRow();
}

/** 详情页「预读专辑」：确认后把整张专辑解码进缓存，成功后自动打「已预读」标签 */
async function prefetchWholeAlbum(album) {
  const rows = state.currentAlbum?.album?.id === album.id ? (state.currentAlbum?.tracks ?? []) : [];
  const pending = rows.flatMap((r) => r.variants ?? []).filter((v) => v.needs_prefetch === true);
  const bytes = pending.reduce((n, v) => n + (Number(v.size) || 0), 0);

  const ok = await askConfirm({
    title: '预读整张专辑',
    text: `将把包内 ${pending.length || Number(album.archive?.tracks ?? 0)} 条曲目解码到缓存`
      + `${bytes ? `（约 ${fmtBytes(bytes)}）` : ''}，完成后播放不再等待。`
      + '缓存目录与上限可在设置里调整。',
    okLabel: '开始预读',
  });
  if (!ok) return;

  showPrefetchProgress('正在预读整张专辑…', '完成前可以继续浏览其它页面');
  try {
    const { result, tag } = await api('/api/archive/prefetch', {
      method: 'POST', body: { albumId: album.id, mode: 'album' },
    });
    // 歌词/台本成员随预读一起落盘，成功时如实告诉用户
    const lyricPart = result.lyrics?.done
      ? `，含 ${result.lyrics.done} 个歌词/台本文件`
      : (result.lyrics?.failed ? `，${result.lyrics.failed} 个歌词文件未能预读` : '');
    if (!result.total) {
      toast('该专辑没有包内曲目，无需预读');
    } else if (result.failed) {
      const first = result.items.find((i) => !i.ok);
      toast(`预读完成 ${result.done}/${result.total}，部分未能完成：${first?.reason ?? first?.code ?? ''}`, true);
    } else {
      toast(`已预读 ${result.done} 条曲目（${fmtBytes(result.bytes)}）${lyricPart}`
        + `${tag ? `，已打标签「${tag.name}」` : ''}`);
    }
  } catch (err) {
    toast(`预读失败：${err.message}`, true);
  } finally {
    hidePrefetchProgress();
  }

  // 缓存状态与「已预读」标签都变了，两边一起刷新
  await Promise.all([openAlbum(album.id, { push: false }), loadTagBar()]);
}

/** 详情页「清除缓存」：只清这一张专辑的缓存，并撤下它的「已预读」标签 */
async function clearAlbumCache(album) {
  const ok = await askConfirm({
    title: '清除该专辑的缓存',
    text: `只删除《${album.album}》已解码到缓存的文件，其它专辑的缓存与压缩包本身都不受影响。`
      + '下次播放时按需重新解码。',
    okLabel: '清除缓存',
    danger: true,
  });
  if (!ok) return;

  try {
    const { result } = await api(`/api/albums/${album.id}/cache/clear`, { method: 'POST', body: {} });
    if (!result.removed && !result.failed) {
      toast('该专辑没有已缓存的曲目');
    } else {
      toast(`已清除 ${result.removed} 个缓存文件（释放 ${fmtBytes(result.freed)}）`
        + `${result.failed ? `，${result.failed} 个被占用未能删除` : ''}`);
    }
  } catch (err) {
    toast(`清除失败：${err.message}`, true);
  }

  await Promise.all([openAlbum(album.id, { push: false }), loadTagBar()]);
}

/** 详情页里与缓存/封面相关的按钮（音声与普通专辑共用一套绑定） */
function bindDetailCacheActions(album) {
  $('#prefetchAlbumBtn')?.addEventListener('click', () => prefetchWholeAlbum(album));
  $('#clearAlbumCacheBtn')?.addEventListener('click', () => clearAlbumCache(album));
}

/** 音声发行详情：版本列表 + 按轨号合并的轨道行 + 特典分组 + 问题面板 + 图片预览 */
async function openVoiceAlbum(data, { push = true, gallery = null } = {}) {
  const { album } = data;
  state.currentAlbum = { album, tracks: data.tracks };

  $('#albumDetail').innerHTML = voiceDetailMarkup(album, data, gallery);
  hydrateGalleryThumbs($('#albumDetail'));

  /**
   * 把某个版本的轨道行变成可播放队列。
   *
   * `override` 用于「点了某个版本 chip」：只覆盖**那一行**用哪个版本，
   * 其余行仍按 preferred 选（见下方版本 chip 的点击处理）。
   */
  const queueFromRows = (rows, override = null) => rows.map((r) => {
    const wanted = override && override.rowKey === r.key ? override.trackId : r.preferred_track_id;
    const v = r.variants.find((x) => x.track_id === wanted)
      ?? r.variants.find((x) => x.track_id === r.preferred_track_id)
      ?? r.variants[0];
    return {
      id: v.track_id, title: r.title, track_no: r.track_no,
      duration: v.duration, ext: v.ext, stream_url: v.stream_url,
      file_kind: v.file_kind,
      // 带上专辑级信息，供单曲详情页显示「艺术家：X  社团：Y」
      artist: album.album_artist,
      album_artist: album.album_artist,
      album_circle: album.circle,
      album_title: album.album,
    };
  }).filter((t) => t.id);

  $('#playAlbumBtn').addEventListener('click', () => {
    const q = queueFromRows(data.tracks ?? []).filter((t) => t.file_kind !== 'video');
    if (!q.length) return toast('没有可播放的音频');
    playQueue(q, 0, { cover: album.cover_url, label: `音声《${album.album}》` });
  });
  $('#tagAlbumBtn').addEventListener('click', () => openTagDialog([album.id], album.tags ?? []));
  $('#editVoiceMediaBtn')?.addEventListener('click', () => openEditDrawer(album.id));
  $('#revealAlbumBtn').addEventListener('click', () => {
    api('/api/reveal', { method: 'POST', body: { path: album.release_root } }).catch(() => {});
  });
  $('#rjCopyBtn')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(album.rj_code ?? '');
      toast(`已复制 ${album.rj_code}`);
    } catch { toast(album.rj_code ?? ''); }
  });
  $('#voiceArtistBtn').addEventListener('click', async () => {
    const name = await askText({
      title: '填写艺术家',
      hint: '仅记录在软件内，不会写回音频文件',
      value: album.album_artist ?? '',
      placeholder: '例如 小花衣こっこ',
    });
    if (name === null) return;
    const res = await api(`/api/albums/${album.id}/voice-artist`, { method: 'POST', body: { artist: name } });
    toast(linkToastText('已保存艺术家（仅库内记录）', res));
    // 自动建立的同名标签 + 卡片署名：标签栏与专辑墙缓存都要同步，否则返回墙后仍是旧样子
    patchAlbumCache(res.tagged_ids, { tag: res.tag, albumArtist: res.album_artist });
    await loadTagBar();
    openAlbum(album.id, { push: false });
  });
  $('#voiceCircleBtn')?.addEventListener('click', async () => {
    const name = await askText({
      title: '填写社团',
      hint: '仅记录在软件内，可作为检索依据，不会写回音频文件',
      value: album.circle ?? '',
      placeholder: '例如 上海飯店',
    });
    if (name === null) return;
    const res = await api(`/api/albums/${album.id}/circle`, { method: 'POST', body: { circle: name } });
    toast(linkToastText('已保存社团（仅库内记录）', res));
    patchAlbumCache(res.tagged_ids, { tag: res.tag, circle: res.circle });
    await loadTagBar();
    openAlbum(album.id, { push: false });
  });
  $('#adoptArtistBtn')?.addEventListener('click', async () => {
    const res = await api(`/api/albums/${album.id}/artist-decision`, {
      method: 'POST', body: { decision: 'adopted' },
    });
    toast(linkToastText('已采用该艺术家（仅软件显示）', res));
    // 采用建议同样会建立同名标签并改署名 —— 与手工填写一样补进缓存
    patchAlbumCache(res.tagged_ids, { tag: res.tag, albumArtist: res.album_artist });
    await loadTagBar();
    openAlbum(album.id, { push: false });
  });
  $('#keepArtistBtn')?.addEventListener('click', async () => {
    await api(`/api/albums/${album.id}/artist-decision`, {
      method: 'POST', body: { decision: 'kept' },
    });
    toast('已保持现状');
    openAlbum(album.id, { push: false });
  });
  $('#voiceIssuesBtn').addEventListener('click', () => loadVoiceIssues(album));
  bindDetailCacheActions(album);

  // 版本 chip：音频切换播放源，视频弹窗播放
  $$('#albumDetail .ver-chip').forEach((btn) => btn.addEventListener('click', () => {
    const row = btn.closest('.voice-row');
    const rowData = [...(data.tracks ?? []), ...(data.bonus_tracks ?? [])]
      .find((r) => r.key === row?.dataset.row);
    const variant = rowData?.variants?.find((v) => v.track_id === Number(btn.dataset.track));

    const startPlayback = () => {
      if (btn.dataset.kind === 'video') {
        openVideoModal(btn.dataset.track, rowData?.title ?? '', btn.dataset.label);
        return true;
      }
      $$('.ver-chip', row).forEach((b) => b.classList.toggle('is-active', b === btn));
      /*
       * 队列必须是**这一整组轨道**，不能只塞被点的这一行 ——
       * 队列长度为 1 时上一首/下一首只能在原地打转，表现出来就是「按钮按了没反应」
       * （用户实测：预读过的压缩包专辑里点版本 chip 播放后，切轨按钮失效）。
       * 起点 = 被点的那一行；被点的版本通过 override 生效，其它行仍用 preferred。
       * 特典行单独成组：点正文里的行排在正文队列，点特典行排在特典队列。
       */
      const mainRows = data.tracks ?? [];
      const bonusRows = data.bonus_tracks ?? [];
      const sourceRows = bonusRows.some((r) => r.key === rowData?.key) ? bonusRows : mainRows;
      const playableRows = sourceRows.filter((r) => {
        const v = r.variants.find((x) => x.track_id === r.preferred_track_id) ?? r.variants[0];
        return v && v.file_kind !== 'video';
      });
      const q = queueFromRows(playableRows, {
        rowKey: rowData?.key, trackId: Number(btn.dataset.track),
      });
      const startIndex = Math.max(0, q.findIndex((t) => t.id === Number(btn.dataset.track)));
      playQueue(q, startIndex, { cover: album.cover_url, label: `音声《${album.album}》` });
      return true;
    };

    // 压缩包来源：未缓存时先让用户决定是否预读取，已缓存直接播放
    if (btn.dataset.needPrefetch === '1') {
      pendingMemberBytes = variant?.size ?? null;
      playArchiveTrack({
        trackId: btn.dataset.track,
        label: variant?.title ?? rowData?.title ?? btn.dataset.label,
        albumId: album.id,
        trackCount: archivedTrackCount(album),
        play: async () => startPlayback(),
      });
      return;
    }
    startPlayback();
  }));

  showView('albumDetail');
  if (push) history.pushState({ id: album.id }, '', `#/album/${album.id}`);
  highlightPlayingRow();
}

/** 视频版播放弹窗 */
function openVideoModal(trackId, title, label) {
  $('#videoModal')?.remove();
  const el = document.createElement('div');
  el.id = 'videoModal';
  el.className = 'video-modal';
  el.innerHTML = `
    <div class="video-box">
      <div class="video-head">
        <span>${esc(title)} · ${esc(label ?? '视频版')}</span>
        <button class="icon-btn" id="videoClose">✕</button>
      </div>
      <video src="/api/stream/${trackId}" controls autoplay playsinline></video>
    </div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  $('#videoClose', el).addEventListener('click', close);
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
}

/** 拉取并渲染「待人工确认」问题（文件名冲突 / 相似轨道是否合并） */
async function loadVoiceIssues(album) {
  const box = $('#voiceIssuesBox');
  if (!box) return;
  box.innerHTML = '<div class="voice-section-title">问题检查中…</div>';
  let data;
  try {
    data = await api(`/api/albums/${album.id}/issues`);
  } catch (err) {
    box.innerHTML = `<div class="voice-section-title">检查失败：${esc(err.message ?? '')}</div>`;
    return;
  }
  const conflicts = data.conflicts ?? [];
  const candidates = data.mergeCandidates ?? [];
  if (!conflicts.length && !candidates.length) {
    box.innerHTML = `<div class="voice-issues is-ok">✓ 没有发现需要人工确认的问题`
      + `${data.ignored?.length ? `（另有 ${data.ignored.length} 个文件按规则忽略）` : ''}</div>`;
    return;
  }
  const conflictHtml = conflicts.map((c) => `
    <div class="issue-item">
      <div class="issue-title">⚠ 文件名与版本标识不一致</div>
      <div class="issue-path">${esc(c.file ?? '')}</div>
      <div class="issue-note">${esc(c.note ?? '')}</div>
      <div class="issue-hint">这个文件属于版本「${esc(c.versionFromFolder ?? '')}」，
        但文件名里残留了「${esc(c.leftover ?? '')}」。请手动重命名文件后重新扫描。</div>
    </div>`).join('');
  const candHtml = candidates.map((c, i) => `
    <div class="issue-item" data-cand="${i}">
      <div class="issue-title">？这两行可能是同一条轨道</div>
      <div class="issue-compare">
        <div>「${esc(c.a.title)}」<em>${esc([...new Set(c.a.versions)].join('、'))}</em></div>
        <div>「${esc(c.b.title)}」<em>${esc([...new Set(c.b.versions)].join('、'))}</em></div>
      </div>
      <div class="issue-note">依据：${esc(c.reason)}（占比 ${c.ratio} · 相似度 ${c.similarity}）</div>
      <div class="issue-actions">
        <button class="btn btn-mini" data-merge="${i}">是同一轨，合并</button>
        <button class="btn btn-mini" data-separate="${i}">不是同一轨</button>
      </div>
    </div>`).join('');

  box.innerHTML = `<div class="voice-issues">
    <div class="voice-section-title">待人工确认（${conflicts.length + candidates.length}）</div>
    ${conflictHtml}${candHtml}</div>`;

  box.querySelectorAll('[data-merge]').forEach((btn) => btn.addEventListener('click', async () => {
    const c = candidates[Number(btn.dataset.merge)];
    await decideMerge(c.a.key, c.b.key, 'merge');
  }));
  box.querySelectorAll('[data-separate]').forEach((btn) => btn.addEventListener('click', async () => {
    const c = candidates[Number(btn.dataset.separate)];
    await decideMerge(c.a.key, c.b.key, 'separate');
  }));

  async function decideMerge(keyA, keyB, decision) {
    try {
      await api(`/api/albums/${album.id}/merge-decision`, {
        method: 'POST', body: { keyA, keyB, decision },
      });
      toast(decision === 'merge' ? '已合并为一条轨道' : '已记录为不同轨道');
      openAlbum(album.id, { push: false });
    } catch (err) {
      toast(`失败：${err.message ?? ''}`);
    }
  }
}

/**
 * 曲目表表头。第 3 列可为「专辑」或「艺术家」，右侧两个手柄用于拖动列宽。
 * 拖动手柄直接挂在列容器上，不占额外列。
 */
function trackTableHeader(thirdColLabel = '专辑') {
  return `
    <div class="track-row is-head" style="border-radius:14px 14px 0 0">
      <div class="t-num">#</div>
      <div class="t-title">标题<i class="col-grip" data-grip="artist" title="拖动调整「艺术家」列宽"></i></div>
      <div class="t-artist">${esc(thirdColLabel)}<i class="col-grip" data-grip="time" title="拖动调整「时长」列宽"></i></div>
      <div class="t-time">时长</div>
    </div>`;
}

/* -------------------------------------------------- 列宽拖动（按列持久化） */

const COL_WIDTH_KEY = 'trackColWidths';

function currentColWidths() {
  // 列宽变量挂在 documentElement 上，让所有曲目表（专辑详情 / 全部曲目）共用同一套设置
  const cs = getComputedStyle(document.documentElement);
  const read = (name, fallback) => {
    const v = parseInt(cs.getPropertyValue(name), 10);
    return Number.isFinite(v) ? v : fallback;
  };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(COL_WIDTH_KEY) ?? '{}'); } catch { /* 忽略 */ }
  return {
    artist: read('--w-artist', Number(saved.artist) || 190),
    time: read('--w-time', Number(saved.time) || 78),
  };
}

function applyColWidths({ artist, time }) {
  const root = document.documentElement;
  root.style.setProperty('--w-artist', `${artist}px`);
  root.style.setProperty('--w-time', `${time}px`);
}

function persistColWidths(widths) {
  try { localStorage.setItem(COL_WIDTH_KEY, JSON.stringify(widths)); } catch { /* 忽略 */ }
}

let colDrag = null;

function bindColumnResize() {
  if (bindColumnResize.done) return;
  bindColumnResize.done = true;

  document.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.col-grip');
    if (!grip) return;
    e.preventDefault();
    const w = currentColWidths();
    colDrag = { kind: grip.dataset.grip, startX: e.clientX, start: w, grip };
    grip.classList.add('is-dragging');
    document.body.classList.add('is-col-resizing');
  });

  document.addEventListener('pointermove', (e) => {
    if (!colDrag) return;
    const dx = e.clientX - colDrag.startX;
    const next = { ...colDrag.start };
    if (colDrag.kind === 'artist') {
      // 手柄在「标题」列右缘 = 艺术家列的左边界：
      // 向右拖 → 标题变宽、艺术家变窄（方向必须与拖动一致）
      next.artist = Math.max(80, Math.min(460, colDrag.start.artist - dx));
    } else {
      // 手柄在「艺术家」列右缘 = 时长列的左边界：
      // 向右拖 → 艺术家变宽、时长变窄
      next.time = Math.max(52, Math.min(180, colDrag.start.time - dx));
    }
    applyColWidths(next);
  });

  document.addEventListener('pointerup', () => {
    if (!colDrag) return;
    colDrag.grip?.classList.remove('is-dragging');
    document.body.classList.remove('is-col-resizing');
    persistColWidths(currentColWidths());
    colDrag = null;
  });
}

function trackRowMarkup(track, index, { showAlbum = true } = {}) {
  const badge = (track.ext ?? '').replace('.', '').toUpperCase();
  const flags = [];
  if (track.parse_error) flags.push('<span class="t-badge" style="color:#ff9a9a">解析失败</span>');
  if (track.meta_source === 'db-override') flags.push('<span class="t-badge" style="color:var(--warn)">未写回</span>');
  // 压缩包来源只在列表数据里保留标记，不在曲目行上显示「包内」（来源信息由专辑角标承担）
  const needPrefetch = track.source_kind === 'archive_member' && track.needs_prefetch === true;
  return `
    <div class="track-row" data-track-index="${index}" data-track-id="${track.id}"
         ${track.source_kind === 'archive_member' ? 'data-from-archive="1"' : ''}
         ${needPrefetch ? 'data-need-prefetch="1"' : ''}>
      <div class="t-num">${track.track_no ?? index + 1}</div>
      <div class="t-title" title="双击播放">
        <span>${esc(track.title)}</span>
        ${badge ? `<em class="t-badge">${esc(badge)}</em>` : ''}
        ${flags.join('')}
      </div>
      ${showAlbum
        ? `<div class="t-album">${esc(track.album_title ?? track.album ?? '(未知专辑)')}</div>`
        : `<div class="t-artist">${esc(track.artist ?? track.album_artist ?? '')}</div>`}
      <div class="t-time">${fmtTime(track.duration)}</div>
      <div class="t-actions">
        ${track.album_kind === 'voice' ? '' : `<button type="button" class="icon-btn fav-track${track.favorite ? ' is-on' : ''}"
          data-fav-track="${track.id}" title="${track.favorite ? '取消喜欢' : '标记为喜欢'}"
          aria-pressed="${track.favorite ? 'true' : 'false'}">
          <svg viewBox="0 0 24 24"><path d="M12 20.5 4.2 13a4.8 4.8 0 0 1 6.8-6.8l1 1 1-1A4.8 4.8 0 0 1 19.8 13z"/></svg>
        </button>`}
        <button type="button" class="icon-btn" data-lyrics="${track.id}" title="查看歌词">
          <svg viewBox="0 0 24 24"><path d="M4 6h16M4 11h10M4 16h13"/></svg>
        </button>
        <button class="icon-btn" data-reveal="${track.id}" title="在资源管理器中显示">
          <svg viewBox="0 0 24 24"><path d="M3 7h5l2 2h11v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
        </button>
      </div>
    </div>`;
}

/* ========================================================== 视图：全部曲目 */

async function loadTracks() {
  const params = new URLSearchParams({ q: state.query, limit: '400' });
  if (state.trackFavOnly) params.set('favorite', '1');
  const { tracks } = await api(`/api/tracks?${params}`);
  state.trackList = tracks;

  const panel = $('#trackTable');
  if (!tracks.length) {
    panel.innerHTML = state.trackFavOnly
      ? '<div class="empty"><div class="empty-emoji">❤</div>'
        + '<h2>还没有喜欢的音乐</h2><p>在「全部曲目」里点击曲目右侧的心形图标即可收藏。'
        + '<br><span style="color:var(--fg-faint)">音声曲目不参与单曲收藏。</span></p></div>'
      : '<div class="empty"><div class="empty-emoji">🎵</div>'
        + '<h2>没有匹配的曲目</h2><p>换个关键词试试。</p></div>';
    return;
  }
  panel.innerHTML = `
    ${trackTableHeader('专辑')}
    ${tracks.map((t, i) => trackRowMarkup(t, i)).join('')}`;
  highlightPlayingRow();
}

/* ============================================================== 视图：标签 */

async function loadTagsView() {
  // 不带 kind = 两套都取；标签页里按「普通专辑 / ASMR」分两大段展示
  const { tags } = await api('/api/tags');
  state.tagsView = tags;

  const rowMarkup = (t) => `
    <div class="tag-row" data-tag-id="${t.id}">
      <span class="tag-swatch" style="background:${tagColor(t.color)}" data-color="${t.id}"
            title="点击切换颜色"></span>
      <span class="tag-name" data-name="${t.id}">${esc(t.name)}</span>
      <select class="tag-cat" data-cat="${t.id}" title="标签分类（决定它在专辑墙上方哪一栏显示）">
        ${TAG_CATEGORY_META.map((c) => `<option value="${c.key}"
           ${(t.category ?? 'style') === c.key ? 'selected' : ''}>${c.label}</option>`).join('')}
      </select>
      <span class="tag-stats">${t.album_count} 张专辑 · ${t.track_count} 首曲目</span>
      <span class="tag-actions">
        <button class="icon-btn" data-pin="${t.id}" title="${t.pinned ? '取消置顶' : '置顶'}"
          style="${t.pinned ? 'color:var(--accent-2)' : ''}">
          <svg viewBox="0 0 24 24"><path d="M12 17v5M9 3h6l-1 7 3 3v2H7v-2l3-3z"/></svg>
        </button>
        <button class="icon-btn" data-rename="${t.id}" title="重命名">
          <svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
        </button>
        <button class="icon-btn" data-merge="${t.id}" title="合并到同一套里的其他标签">
          <svg viewBox="0 0 24 24"><path d="M7 3v6a4 4 0 0 0 4 4h6M17 9l3 4-3 4"/><path d="M7 21v-6"/></svg>
        </button>
        <button class="icon-btn" data-delete="${t.id}" title="删除标签（不删专辑）">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </span>
    </div>`;

  /*
   * 两套标签分两大段（普通专辑 / ASMR），段内仍按「风格 / 社团 / CV」分组 ——
   * 与专辑墙上方一致，只是多了一层「哪一套」的边界。
   */
  const sections = TAG_KIND_META.map((kindMeta) => {
    const list = tags.filter((t) => (t.kind === 'voice' ? 'voice' : 'music') === kindMeta.key);
    if (!list.length) return '';
    const byCategory = groupTagsByCategory(list);
    const groups = TAG_CATEGORY_META.map(({ key, label, hint }) => {
      const items = byCategory.get(key) ?? [];
      if (!items.length) return '';
      return `
        <div class="tag-group">
          <div class="tag-group-head">
            <h3>${label}</h3>
            <span>${items.length} 个 · ${esc(hint)}</span>
          </div>
          ${items.map(rowMarkup).join('')}
        </div>`;
    }).join('');
    return `
      <div class="tag-kind-block">
        <div class="tag-kind-head">
          <h2>${kindMeta.label}</h2>
          <span>${list.length} 个标签 · ${esc(kindMeta.hint)}</span>
        </div>
        ${groups}
      </div>`;
  }).join('');

  $('#tagsPanel').innerHTML = `
    <div class="wb-head">
      <h2>标签</h2>
      <span class="wb-sub">${tags.length} 个标签（普通专辑与 ASMR 是两套相互独立的标签） · 点击名字重命名，点击色块换色；
        分类决定它在专辑墙上方显示在「风格 / 社团 / CV」哪一栏</span>
    </div>
    <div style="display:flex;gap:8px">
      <input type="text" id="newTagName" placeholder="新建标签…" style="background:var(--bg-l0);border:1px solid var(--line-strong);border-radius:10px;padding:9px 12px;color:var(--fg);outline:none;flex:1;max-width:320px" />
      <select id="newTagKind" class="tag-cat" title="新标签属于哪一套">
        ${TAG_KIND_META.map((c) => `<option value="${c.key}">${c.label}</option>`).join('')}
      </select>
      <select id="newTagCat" class="tag-cat" title="新标签的分类">
        ${TAG_CATEGORY_META.map((c) => `<option value="${c.key}">${c.label}</option>`).join('')}
      </select>
      <button class="btn" id="newTagBtn">新建</button>
    </div>
    <div class="wb-list">${sections || '<div class="wb-sub">还没有标签。可以在专辑卡片或详情页点「🏷」创建第一个。</div>'}</div>`;

  // 这两个元素随视图动态生成，必须在这里绑定（不能放在 bindEvents 里）
  const createFromInput = async () => {
    const input = $('#newTagName');
    if (!input.value.trim()) return;
    try {
      await api('/api/tags', {
        method: 'POST',
        body: {
          name: input.value.trim(),
          kind: $('#newTagKind')?.value ?? 'music',
          category: $('#newTagCat')?.value ?? 'style',
        },
      });
      input.value = '';
      await loadTagsView();
      await loadTagBar();
    } catch (err) { toast(err.message, true); }
  };
  $('#newTagBtn').addEventListener('click', createFromInput);
  $('#newTagName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); createFromInput(); }
  });
}

/* ============================================================== 视图：统计 */

async function loadStats() {
  const { stats, lastBackupAt } = await api('/api/stats');
  const thumbs = await thumbCacheStats();
  const coverUsage = await api('/api/maintenance/usage').catch(() => null);
  const jobs = await api('/api/jobs?limit=8').catch(() => ({ jobs: [] }));
  const writerSupport = await api('/api/writer/support').catch(() => null);
  const maxFormat = Math.max(1, ...stats.byFormat.map((f) => f.n));
  const maxArtist = Math.max(1, ...stats.topArtists.map((a) => a.albums));
  const maxTag = Math.max(1, ...(stats.topTags ?? []).map((t) => t.albums || 1));

  $('#statsPanel').innerHTML = `
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-value">${stats.albums}</div><div class="stat-label">专辑</div></div>
      <div class="stat-card"><div class="stat-value">${stats.tracks}</div><div class="stat-label">曲目</div></div>
      <div class="stat-card"><div class="stat-value">${stats.artists}</div><div class="stat-label">艺术家</div></div>
      <div class="stat-card"><div class="stat-value">${stats.tags}</div><div class="stat-label">标签</div></div>
      <div class="stat-card"><div class="stat-value">${esc(fmtLong(stats.total_duration))}</div><div class="stat-label">总时长</div></div>
      <div class="stat-card"><div class="stat-value">${esc(fmtBytes(stats.total_size))}</div><div class="stat-label">占用空间</div></div>
    </div>

    <div class="two-col">
      <div class="panel">
        <h3>格式分布</h3>
        ${stats.byFormat.map((f) => `
          <div class="bar-row">
            <span>${esc(f.format)}</span>
            <span class="bar-track"><i class="bar-fill" style="width:${(f.n / maxFormat) * 100}%"></i></span>
            <span class="bar-value">${f.n} 首</span>
          </div>`).join('') || '<p class="hint">暂无数据</p>'}
      </div>
      <div class="panel">
        <h3>标签分布（Top 15）</h3>
        ${(stats.topTags ?? []).map((t) => `
          <div class="bar-row">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${tagColor(t.color)}">${esc(t.name)}</span>
            <span class="bar-track"><i class="bar-fill" style="width:${((t.albums || 0) / maxTag) * 100}%"></i></span>
            <span class="bar-value">${t.albums} 张</span>
          </div>`).join('') || '<p class="hint">还没有标签</p>'}
      </div>
    </div>

    <div class="two-col">
      <div class="panel">
        <h3>高产艺术家</h3>
        ${stats.topArtists.map((a) => `
          <div class="bar-row">
            <span title="${esc(a.artist)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.artist)}</span>
            <span class="bar-track"><i class="bar-fill" style="width:${(a.albums / maxArtist) * 100}%"></i></span>
            <span class="bar-value">${a.albums} 张</span>
          </div>`).join('') || '<p class="hint">暂无数据</p>'}
      </div>
      <div class="panel">
        <h3>数据安全</h3>
        <p class="hint" style="line-height:1.8">
          标签、库显示名属于<b>用户资产</b>，删除索引不会自动重建它们。<br />
          最近自动备份：${lastBackupAt ? new Date(lastBackupAt).toLocaleString('zh-CN') : '暂无'}<br />
          封面缓存：${coverUsage ? `${coverUsage.covers.files} 个文件 / ${fmtBytes(coverUsage.covers.bytes)}` : '—'}
          ${thumbs ? ` · 缩略图 ${thumbs.count} 张（浏览器缓存）` : ''}
        </p>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <button class="btn" id="exportAssetsBtn">导出用户资产</button>
          <button class="btn" id="snapshotBtn">立即备份</button>
          <button class="btn" id="gcCoversBtn">回收无用封面</button>
          <button class="btn" id="pruneMissingBtn">清理失效索引</button>
          <button class="btn" id="clearThumbsBtn">清理缩略图缓存</button>
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>写操作记录（可撤销）</h3>
      ${jobs.jobs.length ? `<div class="job-history">${jobs.jobs.map((j) => `
        <div class="job-history-row">
          <span class="jh-status is-${j.status}">${j.status}</span>
          <span class="jh-main">#${j.id} ${esc(JOB_LABELS[j.type] ?? j.type)}
            · 成功 ${j.succeeded} / 跳过 ${j.skipped} / 失败 ${j.failed}
            · ${new Date(j.created_at).toLocaleString('zh-CN')}</span>
          ${['done', 'failed', 'interrupted'].includes(j.status)
            ? `<button class="btn btn-ghost" data-undo-job="${j.id}">撤销</button>` : ''}
        </div>`).join('')}</div>`
        : '<p class="hint">还没有写操作记录。编辑专辑信息或更换封面后，这里会显示可撤销的历史。</p>'}
      ${writerSupport ? `<p class="hint" style="margin-top:12px;line-height:1.7">
        写入器：${esc(writerSupport.support.writer)}（${esc(writerSupport.support.license)}）·
        支持 ${writerSupport.support.extensions.length} 种格式 ·
        每次写入都会把原文件完整备份到音乐库根目录的 <code>.lam-undo/</code>
      </p>` : ''}
    </div>`;

  $('#exportAssetsBtn').addEventListener('click', () => {
    window.location.href = '/api/backup/export?download=1';
  });
  $('#snapshotBtn').addEventListener('click', async () => {
    const res = await api('/api/backup/snapshot', { method: 'POST', body: {} });
    toast(res.ok ? '已生成备份快照' : '备份失败', !res.ok);
  });
  $('#gcCoversBtn').addEventListener('click', async () => {
    const res = await api('/api/maintenance/gc-covers', { method: 'POST', body: {} });
    toast(`已回收 ${res.result.files} 个无用封面（释放 ${fmtBytes(res.result.bytes)}）`);
    loadStats();
  });
  $('#pruneMissingBtn').addEventListener('click', async () => {
    const res = await api('/api/maintenance/prune-missing', { method: 'POST', body: {} });
    toast(`已清理 ${res.tracks.removed} 条失效索引、${res.albums.removed} 张空专辑`);
    loadStats();
  });
  $$('#statsPanel [data-undo-job]').forEach((btn) => btn.addEventListener('click', async () => {
    const okUndo = await askConfirm({
      title: '撤销这次写操作',
      text: '会把当时修改过的文件还原到修改前的状态。',
      okLabel: '撤销写入',
      danger: true,
    });
    if (!okUndo) return;
    await undoJob(btn.dataset.undoJob);
    loadStats();
  }));
  $('#clearThumbsBtn').addEventListener('click', async () => {
    try {
      await caches.delete(THUMB_CACHE);
      for (const url of thumbObjectUrls.values()) URL.revokeObjectURL(url);
      thumbObjectUrls.clear();
      toast('缩略图缓存已清理，重新进入专辑墙会自动重建');
      loadStats();
    } catch {
      toast('当前浏览器不支持缓存管理', true);
    }
  });
}

/* ============================================================ 标签弹窗 */

const tagDialogState = { albumIds: [], selected: new Set(), initial: new Set(), bulk: false, all: [], kind: 'music' };

/** 某张专辑属于哪一套标签（普通专辑 / ASMR） */
function albumKindOf(id) {
  const target = Number(id);
  const fromWall = state.albums?.find((a) => Number(a.id) === target);
  if (fromWall) return fromWall.is_voice ? 'voice' : 'music';
  const cur = state.currentAlbum?.album;
  if (cur && Number(cur.id) === target) return cur.is_voice ? 'voice' : 'music';
  return tagKindForView();
}

/**
 * 打标签弹窗该用哪一套标签。
 * 专辑墙与两个收藏页都只展示单一类别，所以批量选择必然是同一类；
 * 万一混合（理论上不会出现），退回当前视图那一套，服务端仍会按各自类别归位。
 */
function dialogTagKind(albumIds) {
  const kinds = new Set((albumIds ?? []).map(albumKindOf));
  return kinds.size === 1 ? [...kinds][0] : tagKindForView();
}

async function openTagDialog(albumIds, currentTags = [], { bulk = false } = {}) {
  tagDialogState.albumIds = albumIds;
  tagDialogState.bulk = bulk;
  tagDialogState.selected = new Set(currentTags.map((t) => t.id));
  tagDialogState.initial = new Set(currentTags.map((t) => t.id));

  // **只列当前专辑所属的那一套标签**，避免把 ASMR 的标签打到普通专辑上
  const kind = dialogTagKind(albumIds);
  tagDialogState.kind = kind;
  const { tags } = await api(`/api/tags?kind=${kind}`);
  tagDialogState.all = tags;

  const kindLabel = kind === 'voice' ? 'ASMR' : '普通专辑';
  $('#tagDlgTitle').textContent = bulk ? `为 ${albumIds.length} 张专辑打标签` : '为专辑添加标签';
  $('#tagDlgHint').textContent = bulk
    ? `选择标签后点「追加」加入这些专辑（${kindLabel}标签）。`
    : `输入标签名回车即可创建，或点击已有标签切换选中（${kindLabel}标签）。`;
  $('#tagInput').value = '';
  $('#tagError').hidden = true;
  renderTagPicker();
  $('#tagDialog').showModal();
  setTimeout(() => $('#tagInput').focus(), 40);
}

function renderTagPicker(filter = '') {
  const all = tagDialogState.all ?? [];
  const kw = filter.trim().toLowerCase();
  const picker = $('#tagPicker');
  const list = all.filter((t) => !kw || t.name.toLowerCase().includes(kw));
  picker.innerHTML = list.map((t) => {
    const on = tagDialogState.selected.has(t.id);
    return `<button type="button" class="tag-pill ${on ? 'is-on' : ''}" data-pick="${t.id}"
        style="${on ? `border-color:${tagColor(t.color)}` : ''}"
        title="${on ? '点击取消选择' : '点击选中'}">
        <span class="tag-tick">${on ? '✓' : ''}</span>
        <span style="width:7px;height:7px;border-radius:50%;background:${tagColor(t.color)}"></span>
        ${esc(t.name)}<span class="tag-count">${t.album_count}</span></button>`;
  }).join('') || '<span class="tag-count">还没有标签，在输入框里输入名字回车即可创建</span>';

  const exact = all.some((t) => t.name.toLowerCase() === kw);
  const suggest = $('#tagSuggest');
  if (kw && !exact) {
    suggest.hidden = false;
    suggest.innerHTML = `<button type="button" class="tag-pill is-create" data-create="1">
      ＋ 新建「${esc(filter.trim())}」并立即应用</button>`;
  } else {
    suggest.hidden = true;
  }

  const n = tagDialogState.selected.size;
  const applyBtn = $('#tagApplyBtn');
  if (tagDialogState.bulk) {
    applyBtn.textContent = n ? `追加到 ${tagDialogState.albumIds.length} 张（已选 ${n}）` : '追加';
  } else {
    applyBtn.textContent = n ? `应用（已选 ${n}）` : '应用';
  }
  applyBtn.dataset.action = tagDialogState.bulk ? 'add' : 'apply';
}

/**
 * 从输入框创建/选中标签。
 * @param {{ applyAfter?: boolean }} opts applyAfter=true 时创建后立刻应用（符合「填名字回车直接打上」）
 */
async function createTagFromInput({ applyAfter = false } = {}) {
  const name = $('#tagInput').value.trim();
  if (!name) return;
  try {
    const kind = tagDialogState.kind ?? 'music';
    // 新建的标签必须落在**当前这张专辑所属的那一套**里
    const { tag } = await api('/api/tags', { method: 'POST', body: { name, kind } });
    tagDialogState.all = (await api(`/api/tags?kind=${kind}`)).tags;
    tagDialogState.selected.add(tag.id);
    $('#tagInput').value = '';
    renderTagPicker();
    if (applyAfter) {
      await applyTagDialog(tagDialogState.bulk ? 'add' : 'apply');
    } else {
      $('#tagInput').focus();
    }
  } catch (err) {
    const box = $('#tagError');
    box.textContent = err.message;
    box.hidden = false;
  }
}

async function applyTagDialog(action = 'apply') {
  const { albumIds, selected, initial, bulk } = tagDialogState;
  try {
    if (bulk) {
      if (!selected.size) throw new Error('请先选择标签');
      const res = await api('/api/albums/tags/bulk', {
        method: 'POST',
        body: { ids: albumIds, add: [...selected], remove: [] },
      });
      toast(`已为 ${res.albums} 张专辑追加 ${res.added} 个标签关联`);
    } else {
      const albumId = albumIds[0];
      const add = [...selected].filter((id) => !initial.has(id));
      const remove = [...initial].filter((id) => !selected.has(id));
      const res = await api(`/api/albums/${albumId}/tags`, { method: 'POST', body: { add, remove } });
      toast(`标签已更新（+${res.added} / -${res.removed}）`);
    }
    $('#tagDialog').close();
    await refreshCurrent();
    syncWallTagsFromDetail();   // 从详情页改的标签，返回专辑墙时也要立刻出现
    await loadTagBar();
  } catch (err) {
    const box = $('#tagError');
    box.textContent = err.message;
    box.hidden = false;
  }
}

/* ============================================================== 播放器 */

function setPlayMode(mode) {
  if (!MODE_META[mode]) return;
  state.playMode = mode;
  localStorage.setItem('playMode', mode);
  $('#modeIcon').innerHTML = modeSvg(mode);
  $('#modeBtn').title = `播放模式：${MODE_META[mode].label}（点击切换）`;
  if (mode === 'shuffle' && state.queue.length) buildShuffleOrder(state.index);
}

function buildShuffleOrder(startIndex = 0) {
  const indices = state.queue.map((_, i) => i).filter((i) => i !== startIndex);
  for (let i = indices.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  state.shuffleOrder = startIndex >= 0 ? [startIndex, ...indices] : indices;
  state.shuffleCursor = 0;
}

function playQueue(tracks, startIndex, { cover = null, label = '' } = {}) {
  if (!tracks?.length) return;
  state.queue = tracks;
  state.nowCover = cover;
  state.queueLabel = label;
  state.history = [];
  if (state.playMode === 'shuffle') buildShuffleOrder(startIndex);
  playAt(startIndex, { record: false });
}

function playAt(index, { record = true } = {}) {
  if (index < 0 || index >= state.queue.length) return;
  if (record && state.index >= 0 && state.index !== index) {
    state.history.push(state.index);
    if (state.history.length > 200) state.history.shift();
  }
  state.index = index;
  if (state.playMode === 'shuffle') {
    const pos = state.shuffleOrder.indexOf(index);
    if (pos >= 0) state.shuffleCursor = pos;
    else buildShuffleOrder(index);
  }
  const track = state.queue[index];
  audio.src = track.stream_url ?? `/api/stream/${track.id}`;
  audio.play().catch((err) => toast(`无法播放：${err.message}`, true));
  updateNowPlaying(track);
  loadLyricsFor(track);
}

function updateNowPlaying(track) {
  $('#player').hidden = false;
  $('#npTitle').textContent = track.title ?? '未知标题';
  $('#npArtist').textContent = [track.artist ?? track.album_artist, track.album_title ?? track.album]
    .filter(Boolean).join(' · ');

  const cover = state.nowCover ?? (track.cover_hash ? `/api/cover/${track.cover_hash}` : null);
  $('#npCover').style.backgroundImage = cover ? `url("${cover}")` : '';
  $('#npBigCover').style.backgroundImage = cover ? `url("${cover}")` : '';
  // 单曲详情：大字标题 + 「艺术家：X  社团：Y」
  $('#npBigTitle').textContent = track.title ?? '未知标题';
  $('#npBigArtist').textContent = track.artist ?? track.album_artist ?? '未知艺术家';
  $('#npBigCircle').textContent = track.album_circle || '—';
  $('#npBigAlbum').textContent = track.album_title ?? track.album ?? '';

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title ?? '',
      artist: track.artist ?? track.album_artist ?? '',
      album: track.album_title ?? track.album ?? '',
      artwork: cover ? [{ src: cover, sizes: '512x512' }] : [],
    });
  }
  highlightPlayingRow();
}

function advance() {
  if (!state.queue.length) return;
  if (state.playMode === 'shuffle') {
    state.shuffleCursor += 1;
    if (state.shuffleCursor >= state.shuffleOrder.length) buildShuffleOrder(-1);
    playAt(state.shuffleOrder[state.shuffleCursor]);
    return;
  }
  const nextIndex = state.index + 1;
  // 顺序播放：播完最后一首就停，不回卷
  if (state.playMode === 'sequential' && nextIndex >= state.queue.length) {
    audio.pause();
    toast('已是最后一首，顺序播放结束');
    return;
  }
  playAt(nextIndex >= state.queue.length ? 0 : nextIndex);
}

function next() { advance(); }

function prev() {
  if (!state.queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  const last = state.history.pop();
  if (last !== undefined) playAt(last, { record: false });
  else playAt(state.index - 1 >= 0 ? state.index - 1 : state.queue.length - 1, { record: false });
}

function setPlayIcon(playing) {
  $('#playIcon').innerHTML = playing
    ? '<path d="M8 5h3v14H8zM13 5h3v14h-3z"/>'
    : '<path d="M7 4l13 8-13 8z"/>';
}

function highlightPlayingRow() {
  const currentId = state.queue[state.index]?.id;
  $$('.track-row').forEach((row) => {
    row.classList.toggle('is-playing', Number(row.dataset.trackId) === currentId);
  });
}

/* ================================================================ 歌词 */

const lyricsSourceLabel = {
  lrc: '同名 .lrc', manual: '手动关联', embedded: '内嵌歌词', txt: '文本歌词',
};
/** 按实际文件格式给出更准确的来源说明 */
const lyricsFormatLabel = {
  lrc: '.lrc 歌词', vtt: '.vtt 字幕', srt: '.srt 字幕', ass: '.ass 字幕', ssa: '.ssa 字幕', txt: '文本台本',
};

async function loadLyricsFor(track) {
  if (!track?.id) return;
  if (state.lyricsTrackId === track.id && state.lyrics) return;
  state.lyricsTrackId = track.id;
  state.lyricIndex = -1;
  $('#lyricsBody').innerHTML = '<div class="lyrics-empty">正在读取歌词…</div>';
  try {
    const data = await api(`/api/tracks/${track.id}/lyrics`);
    if (state.lyricsTrackId !== track.id) return;
    state.lyrics = data;
    renderLyrics();
  } catch (err) {
    state.lyrics = null;
    $('#lyricsBody').innerHTML = `<div class="lyrics-empty">歌词读取失败：${esc(err.message)}</div>`;
  }
}

function renderLyrics() {
  const data = state.lyrics;
  const body = $('#lyricsBody');
  if (!data?.available || !data.lines.length) {
    $('#lyricsSource').textContent = '歌词';
    body.innerHTML = '<div class="lyrics-empty">未找到歌词文件<br />'
      + '<span style="font-size:12px">支持同名 .lrc / .vtt / .srt / .ass / .txt、'
      + '镜像「台本」目录、内嵌歌词与整专辑 album.lrc</span></div>';
    return;
  }
  // 来源文案：字幕文件按真实扩展名显示（.vtt / .srt / .ass），其余沿用层级说明
  const base = lyricsSourceLabel[data.source] ?? data.source;
  const label = data.format && data.format !== 'lrc' && data.source !== 'embedded'
    ? (lyricsFormatLabel[data.format] ?? base)
    : base;
  $('#lyricsSource').textContent = `${label} · ${data.encoding}${data.synced ? '' : ' · 无时间轴'}`;

  const unsynced = data.synced ? '' : '<div class="lyrics-unsynced">该歌词没有时间轴，无法滚动高亮。</div>';
  body.innerHTML = unsynced + data.lines.map((line, i) =>
    `<div class="lyric-line" data-line="${i}"${line.time != null ? ` data-time="${line.time}"` : ''}>
      ${esc(line.text)}${line.translation ? `<span class="lyric-trans">${esc(line.translation)}</span>` : ''}
    </div>`).join('');
  state.lyricIndex = -1;
  syncLyrics(audio.currentTime * 1000);
}

function syncLyrics(ms) {
  const data = state.lyrics;
  if (!data?.synced || !data.lines.length) return;
  let index = -1;
  for (let i = 0; i < data.lines.length; i += 1) {
    if (data.lines[i].time <= ms) index = i; else break;
  }
  if (index === state.lyricIndex) return;
  state.lyricIndex = index;

  const body = $('#lyricsBody');
  $$('.lyric-line', body).forEach((el) => el.classList.toggle('is-current', Number(el.dataset.line) === index));
  if (!state.followLyrics || state.userScrolling || index < 0) return;

  const el = body.querySelector(`.lyric-line[data-line="${index}"]`);
  if (!el) return;
  const top = el.offsetTop - body.clientHeight / 2 + el.clientHeight / 2;
  body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function setNowPlaying(open) {
  $('#nowPlaying').hidden = !open;
  if (open) {
    const track = state.queue[state.index];
    if (track) loadLyricsFor(track);
  }
}

/* ============================================================ 音乐库 */

async function loadLibraries() {
  const { libraries } = await api('/api/libraries');
  state.libraries = libraries;
  renderLibraryList();
}

/**
 * 只重画侧栏的音乐库列表（数据没变、只是选中态变了时用，避免再请求一次）。
 * 启动时先 loadLibraries 再 ensureDefaultLibrary —— 后者会调用它同步高亮。
 */
function renderLibraryList() {
  const libraries = state.libraries ?? [];
  const list = $('#libraryList');
  list.innerHTML = libraries.map((l) => `
    <div class="library-item${String(state.libraryFilter) === String(l.id) ? ' is-active' : ''}"
         data-id="${l.id}" title="${esc(l.path)}\n点击切换到该音乐库（专辑墙只显示这个库的专辑）">
      <span class="lib-path" data-name-slot="${l.id}">${esc(l.display_name)}</span>
      <span class="lib-kind${l.kind === 'voice' ? ' is-voice' : ''}"
            title="${l.kind === 'voice' ? 'ASMR 库：使用 ASMR 那套标签' : '普通专辑库：使用普通专辑那套标签'}">${l.kind === 'voice' ? 'ASMR' : '普通'}</span>
      <span class="lib-count">${l.track_count}</span>
      <button type="button" class="lib-edit icon-btn" data-rename="${l.id}" title="重命名显示名">
        <svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
      </button>
      <button type="button" class="lib-del" data-del="${l.id}" title="移除音乐库">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>`).join('')
    || '<div class="hint" style="color:var(--fg-faint);font-size:12px;padding:4px">还没有添加音乐库</div>';

  $('#brandSub').textContent = libraries.length
    ? `${libraries.length} 个目录 · ${libraries.reduce((n, l) => n + l.track_count, 0)} 首`
    : '未添加音乐库';
}

/**
 * 专辑墙**必须**挂在一个音乐库上（v1.2.4 起，不再有「全部音乐库」）。
 *
 * 之所以这么改：两套标签是按音乐库类别区分的 —— ASMR 库显示 ASMR 那套标签、
 * 普通库显示普通那套。没有「选中的库」就无从决定专辑墙该用哪一套。
 * 这里在启动与增删库时挑一个默认库（优先上次选过的）。
 */
function ensureDefaultLibrary() {
  const libs = state.libraries ?? [];
  if (!libs.length) {
    state.libraryFilter = null;
    renderLibraryList();
    return;
  }
  const saved = Number(localStorage.getItem('libraryId'));
  const exists = libs.some((l) => Number(l.id) === saved);
  state.libraryFilter = exists ? saved : Number(libs[0].id);
  localStorage.setItem('libraryId', String(state.libraryFilter));
  // 选中态是渲染时算出来的，定完默认库要立刻重画，否则侧栏看起来"一个都没选"
  renderLibraryList();
}

/** 切换专辑墙当前音乐库：换库可能换「类别」，此时两套标签完全不通用，旧筛选要清掉 */
async function selectLibrary(id) {
  const prevKind = currentLibraryKind();
  state.libraryFilter = Number(id);
  localStorage.setItem('libraryId', String(state.libraryFilter));
  state.favScope = null;
  state.trackFavOnly = false;
  await loadLibraries();
  const kind = currentLibraryKind();
  if (kind !== prevKind) state.tagFilters.wall.clear();
  /*
   * 点库 = 「回到专辑墙看这个库」。在收藏页里点库也要切回专辑墙 ——
   * 否则 favScope 已清空、视图却还停在收藏页，标签栏与列表会各说各话。
   */
  history.replaceState({}, '', '#/');
  showView('albums');
  await loadTagBar();
  loadAlbums();
  const name = state.libraries?.find((l) => Number(l.id) === Number(id))?.display_name ?? '';
  toast(`已切换到「${name}」`);
}

function startLibraryRename(id) {
  const slot = $(`[data-name-slot="${id}"]`);
  if (!slot || slot.querySelector('input')) return;
  const current = slot.textContent;
  slot.innerHTML = `<input type="text" value="${esc(current)}" maxlength="40" />`;
  const input = slot.querySelector('input');
  input.focus();
  input.select();
  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    if (save) {
      try {
        await api(`/api/libraries/${id}`, { method: 'PATCH', body: { displayName: input.value.trim() } });
        toast('显示名已更新');
      } catch (err) { toast(err.message, true); }
    }
    loadLibraries();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
}

async function startScan() {
  try {
    await api('/api/scan', { method: 'POST', body: {} });
    pollScan();
  } catch (err) {
    toast(err.message, true);
  }
}

function pollScan() {
  clearInterval(state.scanTimer);
  const tick = async () => {
    try {
      const { state: s, running, lastReport } = await api('/api/scan/status');
      $('#scanStatus').hidden = false;
      $('#scanBtn').disabled = running;

      const total = Math.max(s.filesFound, 1);
      const pct = s.phase === '完成' || s.phase === '已取消' ? 100 : Math.min(100, (s.processed / total) * 100);
      $('#scanBarFill').style.width = `${pct}%`;
      $('#scanPhase').textContent = running
        ? `${s.phase}${s.currentLibrary ? ` · ${s.libraryIndex}/${s.libraryTotal}` : ''}`
        : s.phase;
      $('#scanCount').textContent = running
        ? `${s.processed}/${s.filesFound}`
        : `${s.added} 新增 · ${s.updated} 更新`;

      if (!running) {
        clearInterval(state.scanTimer);
        state.scanTimer = null;
        $('#scanBtn').disabled = false;
        /*
         * ⚠ 顺序很关键（v1.2.5 用户实测缺陷：初次扫描 ASMR 库后，识别出的标签不在
         * 专辑墙标签栏里显示）。
         *
         * `loadTagBar()` 按**当前选中音乐库的类别**决定取哪一套标签（普通 / ASMR），
         * 以前这里用 `Promise.all([loadLibraries(), loadTagBar(), refreshCurrent()])`
         * 并行跑 —— 标签栏可能在音乐库列表回来之前就取了，此时 state.libraryFilter
         * 还是空的（或旧库），于是按「普通专辑」那套去取，ASMR 标签自然一个都不显示；
         * 重启软件后启动顺序正确，才恢复正常。
         *
         * 现在改成串行：库列表 → 选中库 → 标签栏 → 当前视图。
         */
        await loadLibraries();
        ensureDefaultLibrary();
        await loadTagBar();
        await refreshCurrent();
        const report = lastReport ?? s;
        const dlsiteHit = report.dlsiteMatched
          ? `，DLsite 命中 ${report.dlsiteMatched} 张（补 ${report.dlsiteFilled ?? 0} 项 · 打标 ${report.dlsiteTagged ?? 0} 张`
            + `${(report.dlsiteCorrected ?? 0) ? ` · 修正 ${report.dlsiteCorrected} 项` : ''}`
            + `${(report.dlsiteRemoved ?? 0) ? ` · 撤旧标签 ${report.dlsiteRemoved}` : ''}）`
          : '';
        toast(`扫描完成：新增 ${report.added}，更新 ${report.updated}，`
          + `清理 ${report.removed ?? 0}，封面 ${report.coverExtracted ?? 0}${dlsiteHit}`);
        if (report.failed) toast(`有 ${report.failed} 个文件处理失败`, true);
        if (report.dlsiteIndexMissing && (report.dlsiteMissed ?? 0) > 0) {
          toast('未找到 DLsite 索引（Dlsite/rj_index.sqlite3），本次没有自动补社团 / 声优', true);
        }
      }
    } catch (err) {
      clearInterval(state.scanTimer);
      state.scanTimer = null;
      $('#scanBtn').disabled = false;
      toast(err.message, true);
    }
  };
  tick();
  state.scanTimer = setInterval(tick, 700);
}

/* ============================================================ 视图切换 */

const VIEWS = ['Albums', 'AlbumDetail', 'Tracks', 'Tags', 'Stats'];

/**
 * 视图映射：多个入口可以复用同一个视图容器。
 * ⚠ 以前 VIEWS 里没有 Favorites，showView('favorites') 会把所有视图都隐藏 → 内容区空白。
 */
const VIEW_MAP = {
  albums: 'Albums',
  favasmr: 'Albums',
  favalbum: 'Albums',
  favtracks: 'Tracks',
  albumDetail: 'AlbumDetail',
  tracks: 'Tracks',
  tags: 'Tags',
  stats: 'Stats',
};
const ALBUM_WALL_VIEWS = ['albums', 'favasmr', 'favalbum'];

function showView(name) {
  const target = VIEW_MAP[name] ?? 'Albums';
  for (const view of VIEWS) $(`#view${view}`).hidden = view !== target;
  $$('.nav-item').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.view === name));
  state.view = name;
  const isAlbumWall = ALBUM_WALL_VIEWS.includes(name);
  $('#bulkBar').hidden = !(isAlbumWall && state.selecting);
  $('#selectModeBtn').hidden = !isAlbumWall;
  // 标签栏按**当前视图**决定取哪一套标签（专辑墙看库类别，收藏页看收藏范围）
  if (isAlbumWall) void loadTagBar();
  else $('#tagBar').hidden = true;
}

async function refreshCurrent() {
  // 三个专辑墙视图共用同一套渲染，都要能刷新
  if (ALBUM_WALL_VIEWS.includes(state.view)) await loadAlbums();
  else if (state.view === 'albumDetail' && state.currentAlbum) {
    await openAlbum(state.currentAlbum.album.id, { push: false });
  } else if (state.view === 'tracks') await loadTracks();
  else if (state.view === 'tags') await loadTagsView();
  else if (state.view === 'stats') await loadStats();
}

/* ============================================================== 多选 */

function syncSelectionUi() {
  document.body.classList.toggle('is-selecting', state.selecting);
  $$('.album-card').forEach((card) => {
    card.classList.toggle('is-selected', state.selected.has(Number(card.dataset.id)));
  });
  const n = state.selected.size;
  $('#bulkCount').textContent = `已选 ${n} 张`;

  // 批量填艺术家/社团只对音声发行可用：选中里没有音声专辑就隐藏这两个按钮
  const voiceCount = state.albums
    .filter((a) => state.selected.has(a.id) && a.is_voice).length;
  const showVoiceOps = voiceCount > 0;
  $('#bulkArtistBtn').hidden = !showVoiceOps;
  $('#bulkCircleBtn').hidden = !showVoiceOps;
  $('#bulkVoiceHint').hidden = !showVoiceOps;
  if (showVoiceOps) {
    const others = n - voiceCount;
    $('#bulkVoiceHint').textContent = others > 0
      ? `其中 ${voiceCount} 张 ASMR 生效 · ${others} 张普通专辑将跳过`
      : `仅对 ASMR 音声发行生效（${voiceCount} 张）`;
  }

  $('#bulkBar').hidden = !(state.selecting && ALBUM_WALL_VIEWS.includes(state.view));
  $('#selectModeBtn').textContent = state.selecting ? '退出多选' : '选择';
  $('#selectModeBtn').classList.toggle('is-active', state.selecting);
}

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  syncSelectionUi();
}

/* ===================================================== V2.2 编辑抽屉 */

const editState = {
  albumId: null, album: null, tracks: [],
  dirty: new Set(), cleared: new Set(),
  pendingCover: null, confirmed: false, voice: false,
  /** 疑似乱码自动修复：key → { key, label, original, fixed, encoding, confidence } */
  autofixes: new Map(),
};

const ALBUM_FIELDS = [
  { key: 'album', label: '专辑名', type: 'text', required: true },
  { key: 'albumArtist', label: '专辑艺术家', type: 'text' },
  { key: 'year', label: '年份', type: 'number' },
  { key: 'genres', label: '流派', type: 'text', hint: '多个流派用 / 分隔' },
];

function originalValue(key) {
  const a = editState.album ?? {};
  const map = {
    album: a.album === '(未知专辑)' ? '' : (a.album ?? ''),
    albumArtist: a.album_artist === '(未知艺术家)' ? '' : (a.album_artist ?? ''),
    year: a.year ?? '',
    genres: a.genre ?? '',
  };
  return map[key] ?? '';
}

function trackOriginal(track, key) {
  return key === 'title' ? (track.title ?? '') : (track.track_no ?? '');
}

function autofixDirtyKey(key) {
  if (key.startsWith('album:')) return key.slice('album:'.length);
  if (key.startsWith('track:')) return `title:${key.split(':')[1]}`;
  return null;
}

function autofixInputKey(key) {
  return autofixDirtyKey(key);
}

function autofixSelector(key) {
  if (key.startsWith('album:')) {
    return `#editBody input[data-field="${key.slice('album:'.length)}"]`;
  }
  if (key.startsWith('track:')) {
    return `#editBody input[data-track="${key.split(':')[1]}"][data-track-field="title"]`;
  }
  return null;
}

function autofixValue(key, fallback) {
  const fix = editState.autofixes.get(key);
  return fix ? fix.fixed : fallback;
}

function autofixBadge(key) {
  const fix = editState.autofixes.get(key);
  if (!fix) return '';
  return `<div class="autofix-inline">
    <span class="autofix-ok">✓ 已自动修复疑似乱码</span>
    <button type="button" class="btn btn-mini" data-autofix-undo="${key}">撤销</button>
    <button type="button" class="btn btn-mini" data-autofix-diff="${key}">查看修改</button>
  </div>`;
}

async function openEditDrawer(albumId) {
  const base = `/api/albums/${encodeURIComponent(albumId)}`;
  // 详情接口给的是展示数据；编辑需要逐文件曲目 + 乱码自检结果。
  const [detail, editTracks, suggestionRes] = await Promise.all([
    api(base),
    api(`${base}/edit-tracks`).catch(() => null),
    api(`${base}/edit-suggestions`).catch(() => ({ suggestions: [] })),
  ]);
  const { album } = detail;
  const tracks = editTracks?.tracks ?? detail.tracks;
  editState.albumId = albumId;
  editState.album = album;
  editState.tracks = tracks;
  editState.dirty.clear();
  editState.cleared.clear();
  editState.pendingCover = null;
  editState.confirmed = false;
  editState.voice = Boolean(album.is_voice);
  editState.autofixes = new Map();
  const readonlyTrackIds = new Set(tracks
    .filter((t) => t.source_kind === 'archive_member' || t.archive_id != null)
    .map((t) => String(t.id)));
  for (const suggestion of suggestionRes?.suggestions ?? []) {
    if (!suggestion?.key || !suggestion.fixed || suggestion.fixed === suggestion.original) continue;
    // 包内文件写不回去，自动修复没有意义；保留原值，输入框本来就是禁用的。
    if (suggestion.key.startsWith('track:')
      && readonlyTrackIds.has(String(suggestion.key.split(':')[1]))) continue;
    editState.autofixes.set(suggestion.key, { ...suggestion });
    const dirtyKey = autofixDirtyKey(suggestion.key);
    if (dirtyKey) editState.dirty.add(dirtyKey);
  }
  const head = $('#editDrawer .drawer-head h3');
  if (head) head.textContent = editState.voice ? '编辑音声媒体文件' : '编辑专辑信息';
  renderEditDrawer();
  $('#drawerBackdrop').hidden = false;
  $('#editDrawer').hidden = false;
}

function closeEditDrawer() {
  $('#editDrawer').hidden = true;
  $('#drawerBackdrop').hidden = true;
  $('#mojibakeDialog')?.close();
  editState.autofixes = new Map();
  editState.albumId = null;
}

function fieldMarkup({ key, label, type, value, hint }) {
  const cleared = editState.cleared.has(key);
  const fixKey = `album:${key}`;
  const fix = editState.autofixes.get(fixKey);
  const shown = cleared ? '' : (fix ? fix.fixed : value);
  const classes = [cleared ? 'is-cleared' : '', fix && !cleared ? 'is-autofixed' : '']
    .filter(Boolean).join(' ');
  return `
    <div class="field">
      <label>${esc(label)}${hint ? ` <span style="color:var(--fg-faint)">· ${esc(hint)}</span>` : ''}</label>
      <div class="field-row">
        <input type="${type}" data-field="${key}" value="${esc(shown)}"
               ${classes ? `class="${classes}"` : ''} ${cleared ? 'disabled' : ''} />
        <button class="clear-btn ${cleared ? 'is-on' : ''}" data-clear="${key}"
                title="${cleared ? '取消清空' : '清空该字段（不点则保持原值）'}">
          ${cleared ? '已清除' : '清除'}
        </button>
      </div>
      ${!cleared && fix ? autofixBadge(fixKey) : ''}
    </div>`;
}

function renderEditDrawer() {
  const a = editState.album;
  const tracks = editState.tracks;
  const coverUrl = a.cover_url;
  const pending = editState.pendingCover;
  const voice = editState.voice;
  const writableCount = tracks.filter((t) => t.source_kind !== 'archive_member' && t.archive_id == null).length;
  const coverDefault = voice ? 'db' : 'embedded';
  const autofixCount = editState.autofixes.size;

  $('#editBody').innerHTML = `
    ${voice ? `<div class="voice-edit-note">
      <b>音声发行 · 媒体文件写回</b><br>
      这里修改的是<b>磁盘音频文件内的标签和封面</b>。压缩包内曲目只读，会自动跳过；
      只想改卡片显示（不碰文件）请用详情页的「填艺术家 / 填写社团 / 标签」。
    </div>` : ''}
    ${autofixCount ? `<div class="autofix-banner">
      <span class="autofix-ok">✓ 已自动修复疑似乱码 <b>${autofixCount}</b> 处</span>
      <span class="autofix-actions">
        <button type="button" class="btn btn-mini" id="autofixUndoAll">撤销</button>
        <button type="button" class="btn btn-mini" id="autofixViewAll">查看修改</button>
      </span>
    </div>` : ''}

    <div class="drawer-section" style="border-top:0;padding-top:0">
      <h4>封面</h4>
      <div class="cover-edit">
        <div class="cover-preview" id="coverPreview"
             style="background-image:url('${pending ?? coverUrl ?? ''}')"></div>
        <div class="cover-controls">
          <div style="font-size:12.5px;color:var(--fg-dim)">
            当前来源：${esc(a.cover_source ?? '无')}
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn" id="pickCoverBtn" style="padding:6px 10px">选择图片…</button>
            <button class="btn btn-primary" id="applyCoverBtn" style="padding:6px 10px"
              ${pending ? '' : 'disabled'}>应用封面</button>
            <button class="btn btn-ghost" id="removeCoverBtn" style="padding:6px 10px">移除封面</button>
          </div>
          <div class="cover-modes">
            <label><input type="radio" name="coverMode" value="embedded"
              ${coverDefault === 'embedded' ? 'checked' : ''} />
              写入每首曲目的内嵌封面（跨软件可见，体积增加）</label>
            <label><input type="radio" name="coverMode" value="folder"
              ${coverDefault === 'folder' ? 'checked' : ''} />
              ${voice ? '只写发行根目录 cover.jpg（省空间，拷走单文件会丢）' : '只写目录 cover.jpg（省空间，拷走单文件会丢）'}</label>
            <label><input type="radio" name="coverMode" value="db"
              ${coverDefault === 'db' ? 'checked' : ''} />
              仅记录在软件内（零风险，重建索引会丢）</label>
          </div>
          ${voice ? `<div class="set-note">当前可写回 ${writableCount} 个磁盘曲目；
            ${tracks.length - writableCount} 个压缩包内曲目会跳过。</div>` : ''}
        </div>
      </div>
    </div>

    <div class="drawer-section">
      <h4>${voice ? `文件标签（写入全部 ${writableCount} 个可写曲目）` : `专辑信息（写入全部 ${tracks.length} 首曲目）`}</h4>
      ${voice ? '<p class="hint" style="font-size:12px;line-height:1.6;margin:0 0 10px">音声卡片的发行标题仍以文件夹/发行结构为准；这里写的是音频文件内的标签。</p>' : ''}
      ${ALBUM_FIELDS.slice(0, 2).map((f) => fieldMarkup({
        ...f, value: originalValue(f.key),
      })).join('')}
      <div class="two-fields" style="margin-top:10px">
        ${ALBUM_FIELDS.slice(2).map((f) => fieldMarkup({ ...f, value: originalValue(f.key) })).join('')}
      </div>
    </div>

    <div class="drawer-section">
      <h4>曲目（只改填写的那一首）</h4>
      ${tracks.map((t) => {
        const readonly = t.source_kind === 'archive_member' || t.archive_id != null;
        const titleKey = `track:${t.id}:title`;
        const titleFix = editState.autofixes.get(titleKey);
        const titleValue = titleFix ? titleFix.fixed : trackOriginal(t, 'title');
        const meta = voice
          ? [t.version_name, readonly ? '包内只读' : null].filter(Boolean).join(' · ')
          : '';
        return `
        <div class="track-edit-row${voice ? ' is-voice' : ''}${readonly ? ' is-readonly' : ''}">
          <span class="idx">${t.track_no ?? ''}</span>
          <input type="text" data-track="${t.id}" data-track-field="title"
                 value="${esc(titleValue)}" placeholder="曲名"
                 ${titleFix ? 'class="is-autofixed"' : ''}
                 ${readonly ? 'disabled title="压缩包内文件只读"' : ''} />
          <input type="number" data-track="${t.id}" data-track-field="trackNo"
                 value="${esc(trackOriginal(t, 'trackNo'))}" placeholder="音轨"
                 ${readonly ? 'disabled' : ''} />
          ${meta ? `<div class="track-edit-meta">${esc(meta)}</div>` : ''}
          ${titleFix ? autofixBadge(titleKey) : ''}
        </div>`;
      }).join('')}
    </div>

    <div class="drawer-section">
      <h4>安全说明</h4>
      <p class="hint" style="font-size:12.5px;line-height:1.7;margin:0">
        保存时会先把原文件复制到工作副本，写入并回读校验后才原子替换；
        原文件会完整保留在音乐库根目录的 <code>.lam-undo/</code> 下，可一键撤销。
        ${voice ? '<br><b>压缩包内文件始终只读</b>，不会被修改。' : ''}
      </p>
    </div>`;

  $('#editImpact').classList.remove('is-error');
  $('#editImpact').textContent = '留空的字段不会被修改；点「清除」才会清空该字段。';
  $('#editSaveBtn').textContent = '保存并写回文件';
  $('#editSaveBtn').disabled = false;
  editState.confirmed = false;
}

function markDirty(input) {
  const key = input.dataset.field
    ? input.dataset.field
    : `${input.dataset.trackField}:${input.dataset.track}`;
  const fixKey = input.dataset.field
    ? `album:${input.dataset.field}`
    : (input.dataset.trackField === 'title' ? `track:${input.dataset.track}:title` : null);
  const fix = fixKey ? editState.autofixes.get(fixKey) : null;
  if (fix) fix.fixed = input.value;
  const original = input.dataset.field
    ? String(originalValue(input.dataset.field))
    : String(trackOriginal(
      editState.tracks.find((t) => String(t.id) === input.dataset.track) ?? {}, input.dataset.trackField,
    ));
  if (String(input.value) === original) {
    editState.dirty.delete(key);
    input.classList.remove('is-dirty');
  } else {
    editState.dirty.add(key);
    input.classList.add('is-dirty');
  }
  editState.confirmed = false;
  $('#editSaveBtn').textContent = '保存并写回文件';
}

function undoAutofix(key) {
  const fix = editState.autofixes.get(key);
  if (!fix) return;
  const snapshot = currentInputs();
  const inputKey = autofixInputKey(key);
  if (inputKey) snapshot[inputKey] = fix.original;
  if (key.startsWith('album:')) editState.cleared.delete(key.slice('album:'.length));
  editState.autofixes.delete(key);
  editState.confirmed = false;
  renderEditDrawer();
  restoreInputs(snapshot);
  const dialog = $('#mojibakeDialog');
  if (dialog?.open) dialog.close();
}

function undoAllAutofix() {
  if (!editState.autofixes.size) return;
  const snapshot = currentInputs();
  for (const [key, fix] of editState.autofixes) {
    const inputKey = autofixInputKey(key);
    if (inputKey) snapshot[inputKey] = fix.original;
    if (key.startsWith('album:')) editState.cleared.delete(key.slice('album:'.length));
  }
  editState.autofixes.clear();
  editState.confirmed = false;
  renderEditDrawer();
  restoreInputs(snapshot);
  $('#mojibakeDialog')?.close();
}

function showAutofixDiff(keys = null) {
  const list = keys
    ? keys.map((key) => editState.autofixes.get(key)).filter(Boolean)
    : [...editState.autofixes.values()];
  if (!list.length) {
    toast('没有可查看的乱码修复');
    return;
  }
  $('#mojibakeList').innerHTML = list.map((fix) => `
    <div class="mojibake-row">
      <div class="mojibake-label">${esc(fix.label ?? fix.key)}</div>
      <div class="mojibake-diff">
        <div class="mojibake-minus">- ${esc(fix.original)}</div>
        <div class="mojibake-plus">+ ${esc(fix.fixed)}</div>
      </div>
      <button type="button" class="btn btn-mini" data-autofix-undo="${fix.key}">撤销此字段</button>
    </div>`).join('');
  const dialog = $('#mojibakeDialog');
  if (!dialog.open) dialog.showModal();
}

/** 汇总成一次请求：专辑级 fields/clear + 逐曲目覆盖 */
function collectEditPayload() {
  const fields = {};
  const clear = [];
  for (const f of ALBUM_FIELDS) {
    if (editState.cleared.has(f.key)) { clear.push(f.key); continue; }
    if (!editState.dirty.has(f.key)) continue;
    const input = $(`[data-field="${f.key}"]`);
    if (!input) continue;
    const raw = input.value.trim();
    if (f.key === 'genres') {
      const list = raw.split('/').map((s) => s.trim()).filter(Boolean);
      if (list.length) fields.genres = list;
    } else if (f.key === 'year') {
      fields.year = Number(raw);
    } else {
      fields[f.key] = raw;
    }
  }

  const trackOverrides = {};
  const trackClears = {};
  for (const t of editState.tracks) {
    for (const key of ['title', 'trackNo']) {
      const id = `${key}:${t.id}`;
      if (!editState.dirty.has(id)) continue;
      const input = $(`[data-track="${t.id}"][data-track-field="${key}"]`);
      if (!input) continue;
      const raw = input.value.trim();
      trackOverrides[t.id] = trackOverrides[t.id] ?? {};
      if (key === 'trackNo') trackOverrides[t.id].trackNo = Number(raw);
      else trackOverrides[t.id].title = raw;
    }
  }
  return { scope: 'album', fields, clear, trackOverrides, trackClears };
}

async function previewEdit() {
  const payload = collectEditPayload();
  if (!Object.keys(payload.fields).length && !payload.clear.length
    && !Object.keys(payload.trackOverrides).length) {
    $('#editImpact').textContent = '还没有任何修改。';
    return null;
  }
  try {
    const res = await api(`/api/albums/${editState.albumId}/metadata/preview`, {
      method: 'POST', body: payload,
    });
    const s = res.preview.summary;
    const skipped = Number(s.unsupported) || 0;
    if (!Number(s.files)) {
      $('#editImpact').classList.add('is-error');
      $('#editImpact').textContent = '没有可写回的磁盘曲目（压缩包内文件只读或格式不支持）';
      return null;
    }
    $('#editImpact').classList.remove('is-error');
    $('#editImpact').innerHTML = `将修改 <b>${s.files}</b> 个文件`
      + `${skipped ? `，跳过 <b>${skipped}</b> 个不可写文件（压缩包内只读或格式不支持）` : ''}`
      + ` · 字段：${esc(s.fields.join('、'))}`;
    return { payload, preview: res.preview };
  } catch (err) {
    $('#editImpact').classList.add('is-error');
    $('#editImpact').textContent = err.message;
    return null;
  }
}

async function saveEdit() {
  if (!editState.confirmed) {
    const result = await previewEdit();
    if (!result) return;
    editState.confirmed = true;
    $('#editSaveBtn').textContent = `确认写入 ${result.preview.summary.files} 个文件`;
    return;
  }
  const btn = $('#editSaveBtn');
  btn.disabled = true;
  try {
    const res = await api(`/api/albums/${editState.albumId}/metadata`, {
      method: 'POST', body: collectEditPayload(),
    });
    closeEditDrawer();
    toast(`已开始写入 ${res.summary.files} 个文件`);
    pollJob(res.jobId);
  } catch (err) {
    $('#editImpact').classList.add('is-error');
    $('#editImpact').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '保存并写回文件';
    editState.confirmed = false;
  }
}

function toggleClear(key) {
  const snapshot = currentInputs();
  if (editState.cleared.has(key)) editState.cleared.delete(key);
  else { editState.cleared.add(key); editState.dirty.delete(key); }
  renderEditDrawer();
  restoreInputs(snapshot);
}

/** 重新渲染前先记住用户已输入的内容，避免丢失未保存的编辑 */
function currentInputs() {
  const map = {};
  $$('#editBody input[data-field]').forEach((i) => { map[i.dataset.field] = i.value; });
  $$('#editBody input[data-track]').forEach((i) => {
    map[`${i.dataset.trackField}:${i.dataset.track}`] = i.value;
  });
  return map;
}

function restoreInputs(map) {
  for (const [key, value] of Object.entries(map)) {
    if (editState.cleared.has(key)) continue;
    const input = key.includes(':')
      ? $(`#editBody input[data-track="${key.split(':')[1]}"][data-track-field="${key.split(':')[0]}"]`)
      : $(`#editBody input[data-field="${key}"]`);
    if (!input) continue;
    input.value = value;
    markDirty(input);
  }
}

/* ------------------------------------------------------------ 封面操作 */

async function applyCover() {
  if (!editState.pendingCover) return;
  const mode = $('input[name="coverMode"]:checked')?.value ?? 'embedded';
  const btn = $('#applyCoverBtn');
  btn.disabled = true;
  btn.textContent = '写入中…';
  try {
    const res = await api(`/api/albums/${editState.albumId}/cover`, {
      method: 'POST',
      body: { imageBase64: editState.pendingCover, mode },
    });
    editState.pendingCover = null;
    if (res.jobId) {
      closeEditDrawer();
      pollJob(res.jobId);
    } else {
      toast('封面已记录（仅存软件内）');
      closeEditDrawer();
      refreshCurrent();
    }
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
    btn.textContent = '应用封面';
  }
}

async function removeCover() {
  const mode = $('input[name="coverMode"]:checked')?.value ?? 'db';
  try {
    const res = await api(`/api/albums/${editState.albumId}/cover`, { method: 'DELETE', body: { mode } });
    if (res.jobId) {
      closeEditDrawer();
      pollJob(res.jobId);
    } else {
      toast('已移除封面记录');
      closeEditDrawer();
      refreshCurrent();
    }
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------------------------------------------------- 写任务进度 */

const JOB_LABELS = {
  metadata: '写入标签', 'cover-embedded': '写入内嵌封面', 'cover-folder': '写入目录封面', undo: '撤销还原',
};

let jobTimer = null;

async function pollJob(jobId) {
  clearInterval(jobTimer);
  const bar = $('#jobBar');
  bar.hidden = false;
  bar.classList.remove('is-done', 'is-error');
  $('#jobUndoBtn').hidden = true;
  $('#jobFill').style.width = '0%';

  const tick = async () => {
    try {
      const { job } = await api(`/api/jobs/${jobId}`);
      const handled = job.succeeded + job.skipped + job.failed;
      const pct = job.total ? Math.round((handled / job.total) * 100) : 100;
      $('#jobFill').style.width = `${pct}%`;
      $('#jobText').textContent = `${JOB_LABELS[job.type] ?? job.type} `
        + `${handled}/${job.total} · 成功 ${job.succeeded} · 跳过 ${job.skipped} · 失败 ${job.failed}`;

      const finished = ['done', 'failed', 'interrupted', 'undone'].includes(job.status);
      bar.classList.toggle('is-done', job.status === 'done');
      bar.classList.toggle('is-error', job.status === 'failed' || job.status === 'interrupted');
      if (!finished) return;

      clearInterval(jobTimer);
      jobTimer = null;
      const undoable = job.items.some((i) => i.backup_file);
      $('#jobUndoBtn').hidden = !undoable;
      $('#jobUndoBtn').dataset.jobId = String(jobId);
      if (job.status === 'done') {
        toast(`写入完成：成功 ${job.succeeded}，跳过 ${job.skipped}，失败 ${job.failed}`);
      } else {
        toast(`写入${job.status === 'interrupted' ? '被中断' : '失败'}：${job.error ?? ''}`, true);
      }
      const failedItems = job.items.filter((i) => i.status === 'failed' || i.status === 'skipped');
      if (failedItems.length) {
        console.warn('未写入的文件：', failedItems.map((i) => `${i.path}：${i.error}`));
      }
      await refreshCurrent();
    } catch (err) {
      clearInterval(jobTimer);
      jobTimer = null;
      toast(err.message, true);
    }
  };
  await tick();
  jobTimer = setInterval(tick, 600);
}

async function undoJob(jobId) {
  try {
    const res = await api(`/api/jobs/${jobId}/undo`, { method: 'POST', body: {} });
    toast(`已撤销：还原 ${res.restored} 个文件${res.failed ? `，${res.failed} 个失败` : ''}`);
    $('#jobBar').hidden = true;
    await refreshCurrent();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ================================ 通用对话框（Electron 不支持 prompt/confirm） */

/**
 * 应用内文本输入框，替代 window.prompt。
 * Electron 的 Chromium 禁用了 prompt/confirm/alert，调用它们不会有任何反应。
 * @returns {Promise<string|null>} 确定返回文本（可为空串），取消返回 null
 */
function askText({ title = '请输入', hint = '', value = '', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const dlg = $('#askDialog');
    $('#askTitle').textContent = title;
    $('#askHint').textContent = hint;
    $('#askHint').hidden = !hint;
    const input = $('#askInput');
    input.value = value ?? '';
    input.placeholder = placeholder;

    const finish = (result) => {
      $('#askOk').removeEventListener('click', onOk);
      $('#askCancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancel);
      input.removeEventListener('keydown', onKey);
      if (dlg.open) dlg.close();
      resolve(result);
    };
    const onOk = () => finish(input.value.trim());
    const onCancel = (e) => { e?.preventDefault?.(); finish(null); };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };

    $('#askOk').addEventListener('click', onOk);
    $('#askCancel').addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onCancel);
    input.addEventListener('keydown', onKey);

    dlg.showModal();
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

/** 应用内确认框，替代 window.confirm */
function askConfirm({ title = '请确认', text = '', okLabel = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = $('#confirmDialog');
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    const ok = $('#confirmOk');
    ok.textContent = okLabel;
    ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;

    const finish = (result) => {
      ok.removeEventListener('click', onOk);
      $('#confirmCancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancel);
      if (dlg.open) dlg.close();
      resolve(result);
    };
    const onOk = () => finish(true);
    const onCancel = (e) => { e?.preventDefault?.(); finish(false); };

    ok.addEventListener('click', onOk);
    $('#confirmCancel').addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
  });
}

/* ============================================================== 事件绑定 */

/** 切换「喜欢」：纯库内标记，不动任何音频文件 */
async function toggleFavorite(albumId, btnEl) {
  const nowOn = !(btnEl?.classList.contains('is-on'));
  try {
    await api(`/api/albums/${albumId}/favorite`, { method: 'POST', body: { value: nowOn } });
  } catch (err) {
    toast(`操作失败：${err.message ?? ''}`);
    return;
  }
  const card = btnEl?.closest('.album-card');
  const local = state.albums.find((a) => a.id === albumId);
  if (local) local.favorite = nowOn;
  if (btnEl) {
    btnEl.classList.toggle('is-on', nowOn);
    btnEl.title = nowOn ? '取消喜欢' : '标记为喜欢';
    btnEl.setAttribute('aria-pressed', nowOn ? 'true' : 'false');
  }
  toast(nowOn ? '❤ 已加入收藏' : '已取消收藏');
  // 在收藏视图里取消喜欢时，卡片应当消失
  if (state.favScope && !nowOn && card) card.remove();
  updateFavoriteBadges();
}

/** 单曲喜欢：音声曲目会被服务端拒绝收录（skipped） */
async function toggleTrackFavorite(trackId, btnEl) {
  const nowOn = !btnEl.classList.contains('is-on');
  let res;
  try {
    res = await api(`/api/tracks/${trackId}/favorite`, { method: 'POST', body: { value: nowOn } });
  } catch (err) {
    toast(`操作失败：${err.message ?? ''}`);
    return;
  }
  if (res.skipped) {
    toast('音声曲目不参与单曲收藏');
    return;
  }
  btnEl.classList.toggle('is-on', nowOn);
  btnEl.title = nowOn ? '取消喜欢' : '标记为喜欢';
  btnEl.setAttribute('aria-pressed', nowOn ? 'true' : 'false');
  const local = state.trackList?.find((t) => t.id === trackId);
  if (local) local.favorite = nowOn;
  toast(nowOn ? '❤ 已加入喜欢的音乐' : '已取消喜欢');
  if (state.trackFavOnly && !nowOn) {
    const row = btnEl.closest('.track-row');
    if (row) row.remove();
  }
  updateFavoriteBadges();
}

/** 三个收藏入口的数量角标 */
async function updateFavoriteBadges() {
  let s = { asmr: 0, albums: 0, tracks: 0 };
  try { s = await api('/api/favorites/summary'); } catch { return; }
  const set = (id, n) => {
    const el = $(id);
    if (!el) return;
    el.textContent = String(n);
    el.hidden = !n;
  };
  set('#favAsmrBadge', s.asmr ?? 0);
  set('#favAlbumBadge', s.albums ?? 0);
  set('#favTrackBadge', s.tracks ?? 0);
}

function bindEvents() {
  $$('.nav-item').forEach((btn) => btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    state.wallSnapshot = null; // 主动点导航 = 重新加载，不用「返回」的进度快照
    history.pushState({}, '', view === 'albums' ? '#/' : `#/${view}`);
    /*
     * 先把「视图 + 收藏范围」定下来，**再**加载数据。
     *
     * ⚠ 顺序不能反：`albumQuery()` → `activeTagFilter()` 是靠 `state.view` 决定用哪一套
     * 标签筛选的。以前这里先 `loadAlbums()` 再 `showView()`，于是首次进收藏页时
     * state.view 还停在上一页（专辑墙），就把**专辑墙的标签筛选**套了进去 ——
     * 表现为「专辑墙筛了『已预读』，喜欢的ASMR 里没预读的那张就消失了」。
     * 收藏视图是跨库的：不清 `state.libraryFilter`（那是专辑墙选中的库），
     * `albumQuery()` 在收藏视图下本来就不会带 libraryId。
     */
    if (view === 'albums') {
      state.favScope = null;
      state.trackFavOnly = false;
      ensureDefaultLibrary();   // 从收藏切回专辑墙时补回库选择（专辑墙必须有库）
    } else if (view === 'favasmr') { state.favScope = 'asmr'; state.trackFavOnly = false; }
    else if (view === 'favalbum') { state.favScope = 'album'; state.trackFavOnly = false; }
    else if (view === 'favtracks') { state.trackFavOnly = true; }
    else if (view === 'tracks') { state.trackFavOnly = false; }

    showView(view);   // ← 必须先切视图：标签筛选套与标签栏都看 state.view

    if (view === 'albums' || view === 'favasmr' || view === 'favalbum') loadAlbums();
    else if (view === 'favtracks' || view === 'tracks') loadTracks();
    else if (view === 'tags') loadTagsView();
    else loadStats();
  }));

  $('#searchInput').addEventListener('input', debounce((e) => {
    state.query = e.target.value.trim();
    refreshCurrent();
  }, 260));

  $('#sortSelect').value = state.sort;
  $('#sortSelect').addEventListener('change', (e) => {
    state.sort = e.target.value;
    localStorage.setItem('sort', state.sort);
    if (state.view === 'albums') loadAlbums();
  });

  $('#tagModeSelect').value = state.tagMode;
  $('#tagModeSelect').addEventListener('change', (e) => {
    state.tagMode = e.target.value;
    localStorage.setItem('tagMode', state.tagMode);
    if (state.view === 'albums') loadAlbums();
  });

  $('#tagBar').addEventListener('click', (e) => {
    const tagBtn = e.target.closest('[data-tag]');
    if (tagBtn) {
      const id = Number(tagBtn.dataset.tag);
      // 只动**当前视图**的筛选集合：专辑墙 / 喜欢的ASMR / 喜欢的专辑互不影响
      const filter = activeTagFilter();
      if (filter.has(id)) filter.delete(id);
      else filter.add(id);
      renderTagBar();
      loadAlbums();
      return;
    }
    if (e.target.closest('[data-clear]')) {
      activeTagFilter().clear();
      renderTagBar();
      loadAlbums();
      return;
    }
    if (e.target.closest('[data-more]')) {
      // 只展开被点的那一栏（按分类独立）
      const cat = e.target.closest('[data-more]')?.dataset.cat;
      if (cat) state.tagBarExpanded.add(cat);
      renderTagBar();
      return;
    }
    if (e.target.closest('[data-less]')) {
      const cat = e.target.closest('[data-less]')?.dataset.cat;
      if (cat) state.tagBarExpanded.delete(cat);
      renderTagBar();
      return;
    }
    const sizeBtn = e.target.closest('[data-size]');
    if (sizeBtn) {
      state.albumSize = sizeBtn.dataset.size;
      localStorage.setItem('albumSize', state.albumSize);
      renderTagBar();
      $('#albumGrid').className = `album-grid size-${state.albumSize}`;
      loadAlbums(); // 重新按新尺寸取缩略图
    }
  });

  /**
   * 窗口宽度变化后重新量一次「第一行能放几个」。
   * 只重算**折叠态**的栏：展开的栏本来就整行铺开，不参与折叠测量。
   */
  let tagBarResizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(tagBarResizeTimer);
    tagBarResizeTimer = setTimeout(() => {
      if (state.view !== 'albums') return;
      for (const box of $$('#tagBar .tagbar-chips')) {
        const cat = box.closest('.tagbar-row')?.dataset.catRow;
        if (state.tagBarExpanded.has(cat)) continue;
        collapseTagRowToFirstLine(box);
      }
    }, 160);
  });

  $('#loadMoreBtn').addEventListener('click', () => loadAlbums({ append: true }));

  $('#selectModeBtn').addEventListener('click', () => {
    state.selecting = !state.selecting;
    if (!state.selecting) state.selected.clear();
    syncSelectionUi();
  });
  $('#bulkExitBtn').addEventListener('click', () => {
    state.selecting = false;
    state.selected.clear();
    syncSelectionUi();
  });
  $('#bulkClearBtn').addEventListener('click', () => {
    state.selected.clear();
    syncSelectionUi();
  });
  $('#bulkTagBtn').addEventListener('click', () => {
    if (!state.selected.size) { toast('请先选择专辑', true); return; }
    openTagDialog([...state.selected], [], { bulk: true });
  });

  /**
   * 批量「从库中移除」：只删索引，**不动任何本地文件**；
   * 同时写入排除清单，以后扫描音乐库会自动跳过这些专辑。
   */
  $('#bulkRemoveBtn').addEventListener('click', async () => {
    const ids = [...state.selected];
    if (!ids.length) { toast('请先选择专辑', true); return; }

    const ok = await askConfirm({
      title: `从音乐库移除 ${ids.length} 张专辑`,
      text: `只会把选中的 ${ids.length} 张专辑从 Luna 的索引里移除，不会删除或修改任何本地文件。\n`
        + '专辑的标签、收藏等库内记录会一并移除（不可恢复）。\n'
        + '以后扫描音乐库时会自动忽略它们，避免又被扫回来；'
        + '需要找回时可在「设置 → 已移除的专辑」里恢复后重新扫描。',
      okLabel: '从库中移除',
      danger: true,
    });
    if (!ok) return;

    try {
      const res = await api('/api/albums/remove', { method: 'POST', body: { ids } });
      toast(`已从音乐库移除 ${res.albums} 张专辑（${res.tracks} 条曲目），本地文件未改动`
        + '；后续扫描会自动忽略它们');
      state.selected.clear();
      state.selecting = false;
      await Promise.all([
        loadAlbums(), loadLibraries(), loadTagBar(), updateFavoriteBadges(),
      ]);
      syncSelectionUi();
    } catch (err) {
      toast(`移除失败：${err.message}`, true);
    }
  });

  /** 批量填写（仅音声发行生效） */
  const bulkVoiceMeta = async (field) => {
    if (!state.selected.size) { toast('请先选择专辑', true); return; }
    const isArtist = field === 'artist';
    const value = await askText({
      title: isArtist ? `为选中的专辑填艺术家` : `为选中的专辑填社团`,
      hint: '仅记录在软件内，不会写回音频文件；普通音乐专辑会自动跳过',
      placeholder: isArtist ? '例如 逢坂成美' : '例如 上海飯店',
    });
    if (value === null) return;
    if (!value) { toast('内容为空，未做改动', true); return; }
    try {
      const res = await api('/api/albums/bulk-voice-meta', {
        method: 'POST', body: { ids: [...state.selected], [field]: value },
      });
      const skipped = res.skipped?.length ?? 0;
      if (!res.updated) {
        toast(`选中的都不是 ASMR 音声发行，未做改动`, true);
      } else {
        toast(linkToastText(
          `已为 ${res.updated} 张音声发行填写${isArtist ? '艺术家' : '社团'}`
            + (skipped ? `，跳过 ${skipped} 张普通专辑` : ''),
          res,
        ));
      }
      state.selected.clear();
      state.selecting = false;
      await loadAlbums();
      await loadTagBar(); // 批量填写同样会建立同名标签，标签栏要跟着刷新
      syncSelectionUi();
    } catch (err) {
      toast(`失败：${err.message ?? ''}`, true);
    }
  };
  $('#bulkArtistBtn').addEventListener('click', () => bulkVoiceMeta('artist'));
  $('#bulkCircleBtn').addEventListener('click', () => bulkVoiceMeta('circle'));

  $('#albumGrid').addEventListener('click', async (e) => {
    const card = e.target.closest('.album-card');
    if (!card) return;
    const id = Number(card.dataset.id);

    if (state.selecting) { toggleSelect(id); return; }

    // 喜欢：无论是否在选卡状态都优先响应（在选卡状态下也应能点心）
    const favBtn = e.target.closest('[data-fav]');
    if (favBtn) {
      e.stopPropagation();
      await toggleFavorite(id, favBtn);
      return;
    }

    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) {
      e.stopPropagation();
      openEditDrawer(id);
      return;
    }

    const playBtn = e.target.closest('[data-play]');
    if (playBtn) {
      e.stopPropagation();
      const { album, tracks } = await api(`/api/albums/${id}`);
      playQueue(tracks, 0, { cover: album.cover_url, label: `专辑《${album.album}》` });
      return;
    }
    openAlbum(id);
  });

  document.addEventListener('click', (e) => {
    // 单曲喜欢（音声曲目不显示该按钮）
    const favTrackBtn = e.target.closest('[data-fav-track]');
    if (favTrackBtn) {
      e.stopPropagation();
      void toggleTrackFavorite(Number(favTrackBtn.dataset.favTrack), favTrackBtn);
      return;
    }
    const lyricsBtn = e.target.closest('[data-lyrics]');
    if (lyricsBtn) {
      e.stopPropagation();
      const id = Number(lyricsBtn.dataset.lyrics);
      if (state.queue[state.index]?.id === id) setNowPlaying(true);
      else toast('播放该曲目后即可查看滚动歌词');
      return;
    }
    const reveal = e.target.closest('[data-reveal]');
    if (reveal) {
      e.stopPropagation();
      api('/api/reveal', { method: 'POST', body: { trackId: Number(reveal.dataset.reveal) } })
        .catch((err) => toast(err.message, true));
      return;
    }
    // 单击曲目行不再播放（避免误触）：见下方 dblclick 处理
  });

  // 双击曲目「名称」播放；音声轨道仍以单击版本按钮播放
  document.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, a, input, select, textarea, .ver-chip')) return;
    const titleCell = e.target.closest('.track-row:not(.is-head) .t-title');
    if (!titleCell) return;
    const row = titleCell.closest('.track-row');
    const index = Number(row?.dataset.trackIndex);
    if (!Number.isInteger(index)) return;
    e.preventDefault();

    const pickQueue = () => {
      if (state.view === 'albumDetail' && state.currentAlbum) {
        return {
          q: state.currentAlbum.tracks,
          opts: {
            cover: state.currentAlbum.album.cover_url,
            label: `专辑《${state.currentAlbum.album.album}》`,
          },
        };
      }
      if (state.view === 'tracks' && state.trackList) {
        return { q: state.trackList, opts: { label: '当前列表' } };
      }
      return null;
    };

    // 压缩包来源：先确定性预读取范围，再播放
    if (row?.dataset.fromArchive === '1' && row?.dataset.needPrefetch === '1') {
      const src = pickQueue();
      const track = src?.q?.[index];
      if (!track) return;
      pendingMemberBytes = track.size ?? null;
      playArchiveTrack({
        trackId: track.id,
        label: track.title ?? track.filename,
        albumId: state.currentAlbum?.album?.id ?? track.album_id ?? null,
        trackCount: src.q.filter((t) => t.source_kind === 'archive_member').length,
        play: async () => { playQueue(src.q, index, src.opts); return true; },
      });
      return;
    }

    const src = pickQueue();
    if (src) playQueue(src.q, index, src.opts);
  });

  $('#backBtn').addEventListener('click', () => history.back());

  /* -------------------------------------------------- V2.2 编辑抽屉与写任务 */

  $('#editCloseBtn').addEventListener('click', closeEditDrawer);
  $('#editCancelBtn').addEventListener('click', closeEditDrawer);
  $('#drawerBackdrop').addEventListener('click', closeEditDrawer);
  $('#editSaveBtn').addEventListener('click', saveEdit);

  $('#editBody').addEventListener('input', (e) => {
    if (e.target.matches('input[data-field], input[data-track]')) markDirty(e.target);
  });
  $('#editBody').addEventListener('click', (e) => {
    const clearBtn = e.target.closest('[data-clear]');
    if (clearBtn) { toggleClear(clearBtn.dataset.clear); return; }
    if (e.target.closest('#autofixUndoAll')) { undoAllAutofix(); return; }
    if (e.target.closest('#autofixViewAll')) { showAutofixDiff(); return; }
    if (e.target.closest('#pickCoverBtn')) $('#coverFileInput').click();
    else if (e.target.closest('#applyCoverBtn')) applyCover();
    else if (e.target.closest('#removeCoverBtn')) removeCover();
  });

  // 乱码修复的「撤销 / 查看修改」按钮在编辑抽屉和 diff 弹窗里都可能出现
  document.addEventListener('click', (e) => {
    const undo = e.target.closest('[data-autofix-undo]');
    if (undo) { undoAutofix(undo.dataset.autofixUndo); return; }
    const diff = e.target.closest('[data-autofix-diff]');
    if (diff) { showAutofixDiff([diff.dataset.autofixDiff]); }
  });

  $('#coverFileInput').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast('图片超过 10MB，请先压缩', true); return; }
    const reader = new FileReader();
    reader.onload = () => {
      editState.pendingCover = String(reader.result);
      const preview = $('#coverPreview');
      if (preview) preview.style.backgroundImage = `url('${editState.pendingCover}')`;
      const btn = $('#applyCoverBtn');
      if (btn) { btn.disabled = false; btn.textContent = '应用封面'; }
      toast('已选择图片，点「应用封面」写入');
    };
    reader.readAsDataURL(file);
  });

  $('#jobUndoBtn').addEventListener('click', (e) => undoJob(e.currentTarget.dataset.jobId));
  $('#jobCloseBtn').addEventListener('click', () => { $('#jobBar').hidden = true; });

  /** 标签分类切换：只改这一张标签的归类，随后同步专辑墙上方的分栏 */
  $('#tagsPanel').addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-cat]');
    if (!sel) return;
    const id = Number(sel.dataset.cat);
    try {
      await api(`/api/tags/${id}`, { method: 'PATCH', body: { category: sel.value } });
      toast(`已归入「${TAG_CATEGORY_LABEL[sel.value] ?? sel.value}」栏`);
      await loadTagsView();
      await loadTagBar();
    } catch (err) {
      toast(err.message, true);
      loadTagsView();
    }
  });

  $('#tagsPanel').addEventListener('click', async (e) => {
    const colorBtn = e.target.closest('[data-color]');
    if (colorBtn) {
      const id = Number(colorBtn.dataset.color);
      const tag = state.tagsView.find((t) => t.id === id);
      await api(`/api/tags/${id}`, { method: 'PATCH', body: { color: (Number(tag.color) + 1) % 8 } });
      loadTagsView();
      return;
    }
    const pinBtn = e.target.closest('[data-pin]');
    if (pinBtn) {
      const id = Number(pinBtn.dataset.pin);
      const tag = state.tagsView.find((t) => t.id === id);
      await api(`/api/tags/${id}`, { method: 'PATCH', body: { pinned: !tag.pinned } });
      loadTagsView();
      return;
    }
    const renameBtn = e.target.closest('[data-rename]');
    if (renameBtn) {
      const id = Number(renameBtn.dataset.rename);
      const slot = $(`[data-name="${id}"]`);
      const tag = state.tagsView.find((t) => t.id === id);
      slot.innerHTML = `<input type="text" value="${esc(tag.name)}" maxlength="24" />`;
      const input = slot.querySelector('input');
      input.focus();
      input.select();
      let done = false;
      const commit = async (save) => {
        if (done) return;
        done = true;
        if (save && input.value.trim() && input.value.trim() !== tag.name) {
          try {
            await api(`/api/tags/${id}`, { method: 'PATCH', body: { name: input.value.trim() } });
            toast('标签已重命名');
          } catch (err) { toast(err.message, true); }
        }
        loadTagsView();
        loadTagBar();
      };
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
        if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
      });
      input.addEventListener('blur', () => commit(true));
      return;
    }
    const mergeBtn = e.target.closest('[data-merge]');
    if (mergeBtn) {
      const id = Number(mergeBtn.dataset.merge);
      const tag = state.tagsView.find((t) => t.id === id);
      const target = await askText({
      title: `合并标签「${tag.name}」`,
      hint: `输入目标标签名，该标签下的专辑会全部转到目标标签（只在「${tag.kind === 'voice' ? 'ASMR' : '普通专辑'}」这一套里找）`,
      placeholder: '目标标签名',
    });
    if (target === null) return;
      if (!target) return;
      // 两套标签相互独立：只在**同一套**里找目标，避免把普通专辑的标签并进 ASMR 那套
      const targetTag = state.tagsView.find(
        (t) => t.kind === tag.kind && t.name.toLowerCase() === target.trim().toLowerCase(),
      );
      if (!targetTag || targetTag.id === id) { toast('目标标签不存在或与源相同', true); return; }
      const res = await api(`/api/tags/${id}/merge`, { method: 'POST', body: { targetId: targetTag.id } });
      toast(`已合并 ${res.moved} 个关联到「${targetTag.name}」`);
      loadTagsView();
      loadTagBar();
      return;
    }
    const delBtn = e.target.closest('[data-delete]');
    if (delBtn) {
      const id = Number(delBtn.dataset.delete);
      const tag = state.tagsView.find((t) => t.id === id);
      const okDelTag = await askConfirm({
      title: `删除标签「${tag.name}」`,
      text: '只会解除它与专辑的关联，不会删除任何专辑或文件。',
      okLabel: '删除标签',
      danger: true,
    });
    if (!okDelTag) return;
      await api(`/api/tags/${id}`, { method: 'DELETE' });
      toast('标签已删除');
      loadTagsView();
      loadTagBar();
    }
  });

  $('#addLibraryBtn').addEventListener('click', () => {
    $('#libError').hidden = true;
    $('#libPathInput').value = '';
    $('#libNameInput').value = '';
    $('#libraryDialog').showModal();
    setTimeout(() => $('#libPathInput').focus(), 40);
  });
  $('#cancelLibBtn').addEventListener('click', () => $('#libraryDialog').close());
  $('#browseBtn').addEventListener('click', async () => {
    const btn = $('#browseBtn');
    btn.disabled = true;
    btn.textContent = '等待选择…';
    try {
      const res = await api('/api/dialog/folder', { method: 'POST', body: {} });
      if (res.ok) $('#libPathInput').value = res.path;
    } catch (err) {
      toast(`无法打开目录选择框，请手动粘贴路径：${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '浏览…';
    }
  });
  $('#confirmLibBtn').addEventListener('click', async () => {
    const path = $('#libPathInput').value.trim();
    if (!path) return;
    try {
      const res = await api('/api/libraries', {
        method: 'POST',
        body: { path, displayName: $('#libNameInput').value.trim() || null },
      });
      $('#libraryDialog').close();
      toast(res.added ? '已添加，开始扫描…' : '该目录已在音乐库中，重新扫描…');
      await loadLibraries();
      pollScan();
    } catch (err) {
      const box = $('#libError');
      box.textContent = err.message;
      box.hidden = false;
    }
  });
  $('#libPathInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#confirmLibBtn').click(); }
  });

  $('#libraryList').addEventListener('click', async (e) => {
    const renameBtn = e.target.closest('[data-rename]');
    if (renameBtn) {
      startLibraryRename(Number(renameBtn.dataset.rename));
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      const id = del.dataset.del;
      const item = $(`.library-item[data-id="${id}"]`);
      const okDel = await askConfirm({
        title: '移除音乐库',
        text: `${item?.title ?? ''}\n\n只会从索引中移除，不会删除任何音频文件。\n该库专辑的标签与编辑记录也会一并移除。`,
        okLabel: '移除',
        danger: true,
      });
      if (!okDel) return;
      await api(`/api/libraries/${id}`, { method: 'DELETE' });
      await loadLibraries();
      // 删掉的若是当前库，得另挑一个（专辑墙必须有库）
      ensureDefaultLibrary();
      await loadTagBar();
      refreshCurrent();
      return;
    }

    /*
     * 点击音乐库条目 = **选中它**。专辑墙必须挂在一个库上，所以不再有「再点一次取消」；
     * 换库若跨了类别（ASMR ↔ 普通），标签那一套也整个换掉。
     */
    const item = e.target.closest('.library-item');
    if (!item) return;
    const id = Number(item.dataset.id);
    // 已经在专辑墙看这个库就不用再切；但在收藏页时点库应当切回专辑墙
    if (String(state.libraryFilter) === String(id) && state.view === 'albums' && !state.favScope) return;
    await selectLibrary(id);
  });

  $('#scanBtn').addEventListener('click', startScan);

  $('#tagInput').addEventListener('input', debounce((e) => renderTagPicker(e.target.value), 120));
  $('#tagInput').addEventListener('keydown', (e) => {
    // 回车 = 创建/选中该标签并立刻应用（省去「新建→重开→选中→应用」的重复操作）
    if (e.key === 'Enter') { e.preventDefault(); createTagFromInput({ applyAfter: true }); }
  });
  $('#tagCreateBtn').addEventListener('click', () => createTagFromInput());
  $('#tagCancelBtn').addEventListener('click', () => $('#tagDialog').close());
  $('#tagApplyBtn').addEventListener('click', (e) => applyTagDialog(e.currentTarget.dataset.action ?? 'apply'));
  $('#tagPicker').addEventListener('click', (e) => {
    const pill = e.target.closest('[data-pick]');
    if (!pill) return;
    const id = Number(pill.dataset.pick);
    if (tagDialogState.selected.has(id)) tagDialogState.selected.delete(id);
    else tagDialogState.selected.add(id);
    renderTagPicker($('#tagInput').value);
  });
  $('#tagSuggest').addEventListener('click', (e) => {
    if (e.target.closest('[data-create]')) createTagFromInput({ applyAfter: true });
  });

  $('#playBtn').addEventListener('click', () => {
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
  });
  $('#prevBtn').addEventListener('click', prev);
  $('#nextBtn').addEventListener('click', next);
  // 快进 / 倒退 5 秒（到边界自动夹住，不越界）
  const nudge = (seconds) => {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = Math.min(Math.max(audio.currentTime + seconds, 0), audio.duration);
    $('#curTime').textContent = fmtTime(audio.currentTime);
    syncLyrics(audio.currentTime * 1000);
  };
  $('#back5Btn').addEventListener('click', () => nudge(-5));
  $('#fwd5Btn').addEventListener('click', () => nudge(5));
  $('#modeBtn').addEventListener('click', () => {
    const idx = MODE_ORDER.indexOf(state.playMode);
    setPlayMode(MODE_ORDER[(idx + 1) % MODE_ORDER.length]);
    toast(`播放模式：${MODE_META[state.playMode].label}`);
  });
  $('#lyricsBtn').addEventListener('click', () => setNowPlaying($('#nowPlaying').hidden));
  $('#npOpen').addEventListener('click', () => setNowPlaying($('#nowPlaying').hidden));
  // 单曲详情：左上角「返回」（取代原来的右上角 ✕）；返回后仍是进入前的那个视图
  $('#npBack').addEventListener('click', () => setNowPlaying(false));

  /* ---------- 单曲详情：封面区域宽度可拖动（默认占窗口一半） ---------- */
  const NP_W_KEY = 'npCoverWidth';
  const applyNpWidth = (pct) => {
    $('#npGrid')?.style.setProperty('--np-cover-w', `${pct}%`);
  };
  const clampNpWidth = (pct) => Math.max(20, Math.min(70, pct));
  let npWidth = clampNpWidth(Number(localStorage.getItem(NP_W_KEY)) || 50);
  applyNpWidth(npWidth);

  let npDrag = null;
  $('#npSplit')?.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const grid = $('#npGrid');
    npDrag = {
      startX: e.clientX,
      startPct: npWidth,
      // 百分比换算基准：整个网格宽度
      gridWidth: grid.getBoundingClientRect().width || 1,
    };
    $('#npSplit').classList.add('is-dragging');
    document.body.classList.add('is-np-resizing');
  });
  document.addEventListener('pointermove', (e) => {
    if (!npDrag) return;
    const dx = e.clientX - npDrag.startX;
    npWidth = clampNpWidth(npDrag.startPct + (dx / npDrag.gridWidth) * 100);
    applyNpWidth(npWidth);
  });
  document.addEventListener('pointerup', () => {
    if (!npDrag) return;
    npDrag = null;
    $('#npSplit')?.classList.remove('is-dragging');
    document.body.classList.remove('is-np-resizing');
    localStorage.setItem(NP_W_KEY, String(Math.round(npWidth)));
  });

  /* ---------- 单曲详情：歌词字号 A+ / A- ---------- */
  const LYRIC_SIZE_KEY = 'lyricFontSize';
  const clampSize = (n) => Math.max(12, Math.min(38, n));
  let lyricSize = clampSize(Number(localStorage.getItem(LYRIC_SIZE_KEY)) || 17);
  const applyLyricSize = () => {
    document.documentElement.style.setProperty('--lyric-size', `${lyricSize}px`);
    $('#lyricsBigger')?.toggleAttribute('disabled', lyricSize >= 38);
    $('#lyricsSmaller')?.toggleAttribute('disabled', lyricSize <= 12);
  };
  const stepLyricSize = (delta) => {
    lyricSize = clampSize(lyricSize + delta);
    localStorage.setItem(LYRIC_SIZE_KEY, String(lyricSize));
    applyLyricSize();
    toast(`歌词字号 ${lyricSize}px`);
  };
  applyLyricSize();
  $('#lyricsBigger').addEventListener('click', () => stepLyricSize(2));
  $('#lyricsSmaller').addEventListener('click', () => stepLyricSize(-2));

  /* ---------- 单曲详情底部的播放控件：直接复用主界面那条播放组件 ---------- */
  $('#lyricsFollow').checked = state.followLyrics;
  $('#lyricsFollow').addEventListener('change', (e) => {
    state.followLyrics = e.target.checked;
    localStorage.setItem('followLyrics', state.followLyrics ? '1' : '0');
  });

  $('#lyricsBody').addEventListener('click', (e) => {
    const line = e.target.closest('.lyric-line');
    if (!line) return;
    const t = Number(line.dataset.time);
    if (Number.isFinite(t)) {
      audio.currentTime = t / 1000;
      syncLyrics(t);
    }
  });
  let scrollTimer;
  $('#lyricsBody').addEventListener('scroll', () => {
    if ($('#nowPlaying').hidden) return;
    state.userScrolling = true;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { state.userScrolling = false; }, 3000);
  });

  audio.addEventListener('play', () => setPlayIcon(true));
  audio.addEventListener('pause', () => setPlayIcon(false));
  audio.addEventListener('ended', () => {
    if (state.playMode === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
    advance();
  });
  audio.addEventListener('error', () => {
    const track = state.queue[state.index];
    if (track) {
      toast(`无法播放「${track.title}」，已跳到下一首`, true);
      setTimeout(() => advance(), 800);
    }
  });
  audio.addEventListener('loadedmetadata', () => {
    $('#durTime').textContent = fmtTime(audio.duration);
  });
  audio.addEventListener('timeupdate', () => {
    $('#curTime').textContent = fmtTime(audio.currentTime);
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      $('#seek').value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    }
    syncLyrics(audio.currentTime * 1000);
  });
  $('#seek').addEventListener('input', (e) => {
    if (!Number.isFinite(audio.duration)) return;
    audio.currentTime = (Number(e.target.value) / 1000) * audio.duration;
  });
  $('#volume').addEventListener('input', (e) => {
    // input 事件本身就是用户手势，可以在这里接上音频图
    applyVolume(e.target.value, { gesture: true });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsOpen()) { closeSettings(); return; }
  if (e.key === 'Escape' && !$('#editDrawer').hidden) { closeEditDrawer(); return; }
    if (e.key === 'Escape' && !$('#nowPlaying').hidden) { setNowPlaying(false); return; }
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
    if (typing) return;
    if (e.code === 'Space') { e.preventDefault(); $('#playBtn').click(); }
    else if (e.code === 'ArrowRight' && e.shiftKey) next();
    else if (e.code === 'ArrowLeft' && e.shiftKey) prev();
    else if (e.key === '/') { e.preventDefault(); $('#searchInput').focus(); }
    else if (e.key === 'l' || e.key === 'L') setNowPlaying($('#nowPlaying').hidden);
    else if (e.key === '1') setPlayMode('list');
    else if (e.key === '2') setPlayMode('one');
    else if (e.key === '3') setPlayMode('shuffle');
  });

  /* ------------------------------------------------- 图片预览：点缩略图看原图 */

  // 缩略图随详情页反复重渲染，因此用事件委托绑在常驻容器上
  $('#albumDetail').addEventListener('click', (e) => {
    // 封面：点开看完整原图（同样走「看原图」浮层）
    const cover = e.target.closest('[data-cover-zoom]');
    if (cover) {
      const album = state.currentAlbum?.album;
      openLightbox([{
        index: 0,
        url: cover.dataset.coverUrl,
        name: `专辑封面 · ${album?.album ?? ''}`.trim(),
        group: '',
      }], 0);
      return;
    }
    const thumb = e.target.closest('[data-gallery-index]');
    if (!thumb) return;
    openLightbox(state.galleryImages, Number(thumb.dataset.galleryIndex));
  });

  $('#lightboxClose').addEventListener('click', closeLightbox);
  $('#lightboxPrev').addEventListener('click', (e) => { e.stopPropagation(); stepLightbox(-1); });
  $('#lightboxNext').addEventListener('click', (e) => { e.stopPropagation(); stepLightbox(1); });
  $('#lightboxOpenBtn').addEventListener('click', () => {
    const img = lightboxState.images[lightboxState.index];
    if (img) window.open(img.url, '_blank');
  });
  // 点背景关闭；点图片本身不关闭（免得看细节时误触）
  $('#lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') closeLightbox();
  });

  /**
   * 看原图时的键盘操作。用**捕获阶段 + stopPropagation**，
   * 否则空格会被下面的播放快捷键抢走、ESC 会去关别的面板。
   */
  document.addEventListener('keydown', (e) => {
    if ($('#lightbox').hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLightbox(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); stepLightbox(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); stepLightbox(1); }
    else if (e.code === 'Space') { e.preventDefault(); e.stopPropagation(); }
  }, true);

  window.addEventListener('popstate', route);
}

/* ================================================================ 路由 */

async function route() {
  const hash = location.hash.replace(/^#/, '');
  if (hash.startsWith('/album/')) {
    await openAlbum(Number(hash.slice('/album/'.length)), { push: false });
    return;
  }
  if (hash === '/tracks') { showView('tracks'); await loadTracks(); return; }  // 收藏视图也要能被直接打开/刷新（三个入口现在各有独立筛选）
  if (hash === '/favasmr') {
    state.favScope = 'asmr'; state.trackFavOnly = false;
    showView('favasmr'); await loadAlbums(); return;
  }
  if (hash === '/favalbum') {
    state.favScope = 'album'; state.trackFavOnly = false;
    showView('favalbum'); await loadAlbums(); return;
  }
  if (hash === '/favtracks') {
    state.trackFavOnly = true; showView('favtracks'); await loadTracks(); return;
  }
  if (hash === '/tags') { showView('tags'); await loadTagsView(); return; }
  if (hash === '/stats') { showView('stats'); await loadStats(); return; }
  // 从专辑详情返回：**原地还原**之前的列表与滚动位置（不重新请求）
  // 两个前提：筛选条件与当时完全一致，且当时确实已经加载出内容 ——
  // 否则老实重新拉，避免把空列表或旧条件下的列表糊弄给用户
  const snap = state.wallSnapshot;
  state.wallSnapshot = null;
  if (snap && snap.query === albumQuery(0) && state.albums.length) {
    showView(snap.view ?? 'albums');
    await loadAlbums({ reuse: true });
    const box = $('#viewAlbums');
    if (box) box.scrollTop = Number(snap.scrollTop) || 0;
    return;
  }
  showView('albums');
  await loadAlbums();
}

/* ================================================================ 启动 */

/* ==================================================== 压缩包预读取（P2 播放） */

/** 详情页打开时记录的候选成员体积，供询问框显示（声明在前，避免 TDZ） */
let pendingMemberBytes = null;

/**
 * 压缩包曲目的播放流程（用户要求）：
 *   点击 → 提示「该发行来自压缩包，播放需预读取」→ 用户选范围（单曲 / 整张）或暂不
 *   → 选是则开始解码到缓存，解码完成后正常播放；选否直接放弃。
 *
 * 预取策略设置决定默认倾向：
 *   off   → 仍然询问（否则用户点了没反应），但默认按钮落在「仅此单曲」
 *   next  → 询问，默认「仅此单曲」
 *   album → 询问，默认「整张专辑」
 */
function prefetchDefaults() {
  const mode = settingsState.config?.archive?.prefetch ?? 'next';
  return { mode, preferAlbum: mode === 'album' };
}

function showPrefetchProgress(title, note) {
  const el = $('#pfProgress');
  if (!el) return;
  $('#pfProgressTitle').textContent = title;
  $('#pfProgressNote').textContent = note ?? '';
  el.hidden = false;
}

function hidePrefetchProgress() {
  const el = $('#pfProgress');
  if (el) el.hidden = true;
}

function fmtMB(bytes) {
  const mb = (Number(bytes) || 0) / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

/** 弹出预读取询问；resolve 为 'track' | 'album' | null（暂不） */
function askPrefetch({ label, memberBytes, trackCount }) {
  return new Promise((resolve) => {
    const dlg = $('#prefetchDialog');
    if (!dlg) { resolve(null); return; }
    const { preferAlbum } = prefetchDefaults();

    $('#pfText').innerHTML = [
      label ? `曲目：<b>${esc(label)}</b>` : '',
      memberBytes ? `单曲解压后约 <b>${fmtMB(memberBytes)}</b>` : '',
      trackCount > 1 ? `整张共 <b>${trackCount}</b> 条` : '',
      settingsState.cache
        ? `缓存上限 ${fmtMB(settingsState.cache.maxBytes)}，已用 ${fmtMB(settingsState.cache.bytes)}`
        : '',
    ].filter(Boolean).join(' · ');

    // 按预取策略调整默认按钮的视觉权重
    $('#pfAlbum').classList.toggle('btn-primary', preferAlbum);
    $('#pfAlbum').classList.toggle('btn-ghost', !preferAlbum);
    $('#pfTrack').classList.toggle('btn-primary', !preferAlbum);
    $('#pfTrack').classList.toggle('btn-ghost', preferAlbum);

    const done = (v) => {
      dlg.close();
      resolve(v);
    };
    $('#pfTrack').onclick = () => done('track');
    $('#pfAlbum').onclick = () => done('album');
    $('#pfCancel').onclick = () => done(null);
    dlg.oncancel = () => { resolve(null); };   // ESC
    dlg.showModal();
  });
}

/**
 * 按需解码后再播放。
 * @returns {Promise<boolean>} 是否已进入播放（false 表示用户放弃或失败）
 */
async function playArchiveTrack({ trackId, label, albumId, trackCount, play }) {
  const answer = await askPrefetch({
    label,
    memberBytes: pendingMemberBytes,
    trackCount,
  });
  if (!answer) return false;   // 用户选择暂不

  const wholeAlbum = answer === 'album' && albumId;
  showPrefetchProgress(
    wholeAlbum ? '正在预读取整张专辑…' : '正在预读取…',
    wholeAlbum ? '首次播放需要把包内文件解码到缓存，可能需要一会儿' : '正在把包内文件解码到缓存',
  );

  try {
    const body = wholeAlbum
      ? { albumId, mode: 'album' }
      : { trackId };
    const { result } = await api('/api/archive/prefetch', { method: 'POST', body });

    // 整张模式下若有失败项，把首个原因说清楚（多半是文件过大）
    const firstFail = result.items?.find((i) => !i.ok);
    if (wholeAlbum && firstFail) {
      toast(`部分曲目未能预读取：${firstFail.reason ?? firstFail.code}`, true);
    }
    if (!wholeAlbum && !result.ok) {
      toast(result.items?.[0]?.reason ?? '预读取失败', true);
      return false;
    }
    if (!wholeAlbum && result.done === 0) {
      toast('预读取未能完成，无法播放', true);
      return false;
    }

    /**
     * 整张预读取成功后必须**就地刷新详情页**。
     * 否则界面拿的还是进页面时那份数据（needs_prefetch 仍为 true），
     * 点下一首会再弹一次询问 —— 用户实测反馈的就是这个。
     */
    if (wholeAlbum && !firstFail) markAlbumCached();

    await refreshCacheBadge();
    return await play();
  } catch (err) {
    toast(`预读取失败：${err.message}`, true);
    return false;
  } finally {
    hidePrefetchProgress();
  }
}

/** 刷新缓存用量（设置面板若开着，顺手更新，省得数字过时） */
async function refreshCacheBadge() {
  await loadCacheStatus();
  if (settingsOpen()) renderSettings();
}

/**
 * 整张预读取成功后：**就地重新加载详情页**。
 *
 * 必须重新拉一次数据 —— 否则界面拿的还是进页面时那份（needs_prefetch 仍为 true），
 * 点下一首会再弹一次询问。这正是用户实测反馈的问题。
 * push:false 保证不污染浏览器历史。
 */
function markAlbumCached() {
  const albumId = state.currentAlbum?.album?.id;
  if (albumId) openAlbum(albumId, { push: false });
}

/** 该专辑里还有多少条曲目仍需先预读取（供询问框显示「整张共 N 条」） */
function archivedTrackCount(album) {
  const all = [...(album?.tracks ?? []), ...(album?.bonus_tracks ?? [])];
  return all.flatMap((r) => r.variants ?? []).filter((v) => v.needs_prefetch === true).length;
}

/* ================================================================== 设置面板 */

/**
 * 设置面板（⚙）。
 *
 * 两类项目的保存方式刻意不同：
 *   - 外观（配色 / 背景透明 / 背景图）**即时生效并自动保存** —— 所见即所得；
 *   - 压缩包（预取策略 / 缓存上限 / 缓存目录）**点「保存设置」才提交** ——
 *     这些值影响后端行为，不适合边拖边存。
 */
const SETTINGS_THEMES = [
  { id: 'midnight', name: '午夜紫', dots: ['#0b0b0f', '#7d6cf5', '#43dfb8'] },
  { id: 'nebula', name: '星际青', dots: ['#061418', '#2fd4e0', '#7be8a8'] },
  { id: 'graphite', name: '石墨橙', dots: ['#121212', '#ff8a3d', '#ffd166'] },
];
const PREFETCH_LABELS = [
  { id: 'off', name: '不预读取', note: '播放时才解码。最省磁盘，首次播放等待最久。' },
  { id: 'next', name: '仅预读取下一首', note: '队列里提前解码下一轨，减少切曲停顿。' },
  { id: 'album', name: '预读取专辑', note: '进入详情页就解码整张。音声整张连听最顺，但占缓存最多。' },
];
const GIB = 1024 ** 3;

const settingsState = { config: null, cache: null, exclusions: [] };

const bgImageUrl = (p) => (p ? `/api/local-image?path=${encodeURIComponent(p)}` : '');

/**
 * 外观即时套用：只写 CSS 变量与 data-* 属性，不重启动、不刷新。
 * 底色用 color-mix 与 transparent 混合，从而支持背景透明度。
 */
function applyAppearance(appearance) {
  const a = appearance ?? {
    theme: 'midnight', mode: 'dark', bgOpacity: 100, bgImage: null,
  };
  const root = document.documentElement;
  root.dataset.theme = a.theme || 'midnight';
  root.dataset.mode = a.mode === 'light' ? 'light' : 'dark';
  const pct = Math.min(100, Math.max(0, Number(a.bgOpacity)));
  root.style.setProperty('--bg-alpha-pct', `${Number.isFinite(pct) ? pct : 100}%`);

  if (a.bgImage) {
    root.style.setProperty('--bg-image', `url("${bgImageUrl(a.bgImage)}")`);
    // 有背景图时侧栏改用覆盖式半透明底（否则「中间透、两边实」很割裂）。
    // 基色走 --overlay-rgb，浅色模式下才不会变成一块黑。
    root.style.setProperty('--sidebar-bg', 'rgba(var(--overlay-rgb), .9)');
  } else {
    root.style.removeProperty('--bg-image');
    root.style.removeProperty('--sidebar-bg');
  }
}

/** 保存外观（只提交 appearance 段；后端按段合并，不会动其它设置） */
async function saveAppearance(patch) {
  settingsState.config = {
    ...settingsState.config,
    appearance: { ...(settingsState.config?.appearance ?? {}), ...patch },
  };
  applyAppearance(settingsState.config.appearance);
  try {
    const { config } = await api('/api/config', { method: 'POST', body: { appearance: patch } });
    settingsState.config = config;
  } catch (err) {
    toast(`外观设置保存失败：${err.message}`, true);
  }
}

/** 可读体积统一用本文件既有的 fmtBytes()（函数声明提升，此处可直接调用） */

async function loadSettingsConfig() {
  try {
    const { config } = await api('/api/config');
    settingsState.config = config;
    applyAppearance(config.appearance);
  } catch { /* 取不到配置不阻塞启动，外观保持默认 */ }
  return settingsState.config;
}

async function loadCacheStatus() {
  try {
    const { cache } = await api('/api/archive/cache');
    settingsState.cache = cache;
  } catch (err) {
    settingsState.cache = { error: err.message };
  }
  return settingsState.cache;
}

/** 「已移除的专辑」清单：扫描时会自动跳过这些专辑，这里是唯一的恢复入口 */
async function loadExclusions() {
  try {
    const { exclusions } = await api('/api/exclusions');
    settingsState.exclusions = exclusions ?? [];
  } catch {
    settingsState.exclusions = [];
  }
  return settingsState.exclusions;
}

function settingsMarkup() {
  const cfg = settingsState.config ?? {};
  const arch = cfg.archive ?? { prefetch: 'next', cacheDir: '', maxBytes: 20 * GIB };
  const app = cfg.appearance ?? {
    theme: 'midnight', mode: 'dark', bgOpacity: 100, bgImage: null,
  };
  const cache = settingsState.cache ?? {};
  const desktop = cfg.desktop ?? { minimizeToTray: false };
  // 浏览器里运行时没有托盘可言，如实说明（避免用户以为设置没生效）
  const desktopShell = /electron/i.test(navigator.userAgent);
  const exclusions = settingsState.exclusions ?? [];

  const used = Number(cache.bytes ?? 0);
  const max = Number(cache.maxBytes ?? arch.maxBytes ?? 0);
  const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0;
  const warn = pct >= 85;
  const crossVolume = cache.sameVolumeAsData === false;
  const unwritable = cache.writable === false;
  const prefetchNote = PREFETCH_LABELS.find((p) => p.id === arch.prefetch)?.note ?? '';

  return `
    <section class="set-sec">
      <h4>压缩包 <span class="set-sec-tag">P2</span></h4>
      <div class="set-row">
        <div class="set-label">预取策略</div>
        <div class="set-control">
          <select class="set-select" id="setPrefetch">
            ${PREFETCH_LABELS.map((p) => `<option value="${p.id}"${arch.prefetch === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
          <div class="set-note" id="setPrefetchNote">${esc(prefetchNote)}</div>
        </div>
      </div>
      <div class="set-row">
        <div class="set-label">缓存上限</div>
        <div class="set-control">
          <div class="set-inline">
            <input class="set-input" id="setMaxGb" type="number" min="0.5" step="0.5"
                   value="${(Number(arch.maxBytes ?? 20 * GIB) / GIB).toFixed(1)}" />
            <span class="set-note">GB</span>
          </div>
          <div class="set-bar${warn ? ' is-warn' : ''}"><i style="width:${pct.toFixed(1)}%"></i></div>
          <div class="set-note">
            已用 <b>${fmtBytes(used)}</b> / ${fmtBytes(max)}（${pct.toFixed(1)}%）
            ${cache.freeBytes != null ? ` · 磁盘剩余 ${fmtBytes(cache.freeBytes)}` : ''}
            ${cache.files ? ` · ${cache.files} 个文件` : ''}
          </div>
          <div class="set-note">需要解码的文件若大于该上限，会放弃读取并提示文件过大。最小 0.5 GB。</div>
        </div>
      </div>
      <div class="set-row">
        <div class="set-label">缓存目录</div>
        <div class="set-control">
          <div class="set-inline">
            <input class="set-input" id="setCacheDir" type="text" value="${esc(arch.cacheDir ?? '')}" placeholder="留空使用默认目录" />
            <button class="btn btn-ghost" id="setCacheDirPick">浏览…</button>
          </div>
          <div class="set-note${unwritable ? ' is-error' : ''}">
            ${unwritable
    ? `该目录不可写：${esc(cache.error ?? '权限不足')}`
    : `默认 luna_cache（应用根目录下）。${cache.exists ? '' : '目录尚未创建，首次播放时才生成。'}`}
          </div>
          ${crossVolume ? '<div class="set-note is-warn">⚠ 缓存目录与数据目录不在同一个盘：跨盘拷贝会明显削弱缓存加速效果。</div>' : ''}
        </div>
      </div>
      <div class="set-row">
        <div class="set-label">清理</div>
        <div class="set-control">
          <div class="set-inline">
            <button class="btn btn-ghost" id="setClearCache">清空缓存</button>
            <span class="set-note">只删除缓存内容，不影响音乐库与压缩包。</span>
          </div>
        </div>
      </div>
    </section>

    <section class="set-sec">
      <h4>外观</h4>
      <div class="set-row">
        <div class="set-label">深浅模式</div>
        <div class="set-control">
          <div class="seg-list">
            <button type="button" class="seg${app.mode !== 'light' ? ' is-active' : ''}" data-mode-pick="dark">深色</button>
            <button type="button" class="seg${app.mode === 'light' ? ' is-active' : ''}" data-mode-pick="light">浅色</button>
          </div>
          <div class="set-note">浅色模式会翻转底色与文字颜色，适合搭配浅色背景图。</div>
        </div>
      </div>
      <div class="set-row">
        <div class="set-label">配色方案</div>
        <div class="set-control">
          <div class="theme-list">
            ${SETTINGS_THEMES.map((t) => `
              <div class="theme-card${app.theme === t.id ? ' is-active' : ''}" data-theme-pick="${t.id}" role="button" tabindex="0">
                <div class="theme-dots">${t.dots.map((c) => `<i style="background:${c}"></i>`).join('')}</div>
                <div class="theme-name">${esc(t.name)}</div>
              </div>`).join('')}
          </div>
          <div class="set-note">切换后立即生效并自动保存。</div>
        </div>
      </div>
      <div class="set-row">
        <div class="set-label">背景透明度</div>
        <div class="set-control">
          <div class="set-slider">
            <input type="range" id="setBgOpacity" min="0" max="100" step="1" value="${Number(app.bgOpacity ?? 100)}" />
            <span class="set-slider-val" id="setBgOpacityVal">${Number(app.bgOpacity ?? 100)}%</span>
          </div>
          <div class="set-note">数值越小，界面底色越透明；配自定义背景图时观感最明显。</div>
        </div>
      </div>
      <div class="set-row">
        <div class="set-label">背景图片</div>
        <div class="set-control">
          <div class="bg-preview" id="setBgPreview"
               style="${app.bgImage ? `background-image:url('${esc(bgImageUrl(app.bgImage))}')` : ''}">
            ${app.bgImage ? '' : '未设置背景图'}
          </div>
          <div class="set-inline">
            <button class="btn btn-ghost" id="setBgPick">选择图片…</button>
            <button class="btn btn-ghost" id="setBgClear">移除背景</button>
          </div>
          <div class="set-note" id="setBgPath">${app.bgImage ? esc(app.bgImage) : '支持 jpg / png / webp / gif / bmp。'}</div>
        </div>
      </div>
    </section>

    <section class="set-sec">
      <h4>桌面</h4>
      <div class="set-row">
        <div class="set-label">关闭窗口时</div>
        <div class="set-control">
          <div class="seg-list">
            <button type="button" class="seg${desktop.minimizeToTray ? '' : ' is-active'}"
                    data-tray-pick="0">退出程序</button>
            <button type="button" class="seg${desktop.minimizeToTray ? ' is-active' : ''}"
                    data-tray-pick="1">最小化到托盘</button>
          </div>
          <div class="set-note">
            ${desktop.minimizeToTray
    ? '点窗口的 × 只是收进托盘，播放与扫描照常继续；要真正退出请用托盘菜单的「退出 Luna」或菜单栏「文件 → 退出」。'
    : '点窗口的 × 直接退出 Luna（当前行为）。'}
          </div>
          ${desktopShell ? '' : '<div class="set-note is-warn">⚠ 当前不是桌面版（在浏览器里打开）：没有托盘可用，该设置不会生效。</div>'}
        </div>
      </div>
    </section>

    <section class="set-sec">
      <h4>已移除的专辑</h4>
      ${excludedSectionMarkup(exclusions)}
    </section>
  `;
}

/** 「已移除的专辑」列表：恢复后需重新扫描才会回到专辑墙，文案里写明 */
function excludedSectionMarkup(exclusions) {
  if (!exclusions.length) {
    return `
      <div class="set-row">
        <div class="set-label">（空）</div>
        <div class="set-control">
          <div class="set-note">
            没有被移除的专辑。在专辑墙进入多选、选中若干张后点「从库中移除」，
            即可把它们移出音乐库 —— <b>只会删索引，不碰本地文件</b>。
          </div>
        </div>
      </div>`;
  }
  const rows = exclusions.map((x) => `
    <div class="set-row">
      <div class="set-label" title="${esc(x.root_path ?? '')}">${esc(x.title || '(无标题)')}</div>
      <div class="set-control">
        <div class="set-inline">
          <span class="set-note">${Number(x.track_count) || 0} 条曲目 ·
            ${new Date(Number(x.removed_at) || Date.now()).toLocaleDateString('zh-CN')}</span>
          <button class="btn btn-ghost" data-restore="${x.id}">恢复</button>
        </div>
        <div class="set-note" style="word-break:break-all">${esc(x.root_path ?? '')}</div>
      </div>
    </div>`).join('');
  return `
    ${rows}
    <div class="set-row">
      <div class="set-label">全部恢复</div>
      <div class="set-control">
        <div class="set-inline">
          <button class="btn btn-ghost" id="setRestoreAll">全部恢复（${exclusions.length} 张）</button>
          <span class="set-note">恢复后需要重新扫描音乐库，这些专辑才会回到专辑墙。</span>
        </div>
      </div>
    </div>`;
}

function renderSettings() {
  const body = $('#settingsBody');
  if (!body) return;
  body.innerHTML = settingsMarkup();
  bindSettingsBody();
}

async function refreshSettings({ reloadConfig = true } = {}) {
  if (reloadConfig || !settingsState.config) await loadSettingsConfig();
  await Promise.all([loadCacheStatus(), loadExclusions()]);
  renderSettings();
}

function settingsOpen() { return !$('#settingsDrawer')?.hidden; }

function openSettings() {
  $('#settingsDrawer').hidden = false;
  $('#settingsBackdrop').hidden = false;
  $('#settingsBtn').classList.add('is-active');
  renderSettings();
  refreshSettings();
}

function closeSettings() {
  $('#settingsDrawer').hidden = true;
  $('#settingsBackdrop').hidden = true;
  $('#settingsBtn')?.classList.remove('is-active');
}

/** 提交压缩包设置（预取 / 上限 / 目录） */
async function saveArchiveSettings() {
  const prefetch = $('#setPrefetch')?.value ?? 'next';
  const gb = Number($('#setMaxGb')?.value ?? 20);
  const cacheDir = $('#setCacheDir')?.value?.trim() ?? '';
  if (!Number.isFinite(gb) || gb <= 0) { toast('缓存上限需要是正数（GB）', true); return; }

  const prevDir = settingsState.cache?.dir ?? '';
  try {
    const { config } = await api('/api/config', {
      method: 'POST', body: { archive: { prefetch, maxBytes: Math.round(gb * GIB), cacheDir } },
    });
    settingsState.config = config;
    const label = PREFETCH_LABELS.find((p) => p.id === config.archive.prefetch)?.name ?? '';
    if (config.archive.cacheDir !== prevDir) {
      // 换目录不会自动搬旧缓存，必须说清楚，否则用户会以为空间没释放
      toast(`设置已保存。缓存目录改为 ${config.archive.cacheDir}，原有缓存不会自动迁移。`);
    } else {
      toast(`设置已保存：${label} · 上限 ${(config.archive.maxBytes / GIB).toFixed(1)} GB`);
    }
    await refreshSettings();
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
  }
}

/** 桌面外壳设置：关闭窗口的行为（改动立即保存并生效，主进程在关闭那一刻现读） */
async function saveDesktopSetting(minimizeToTray) {
  try {
    const { config } = await api('/api/config', { method: 'POST', body: { desktop: { minimizeToTray } } });
    settingsState.config = config;
    toast(minimizeToTray
      ? '已设置：点 × 收进托盘，仍会继续播放与扫描'
      : '已设置：点 × 直接退出 Luna');
    await refreshSettings();
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
  }
}

/** 设置抽屉内控件的事件（每次重绘都要重新绑） */
function bindSettingsBody() {
  // 「已移除的专辑」：逐条恢复 / 全部恢复（恢复后需重新扫描才会回墙）
  $$('#settingsBody [data-restore]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const r = await api('/api/exclusions/restore', {
          method: 'POST', body: { ids: [Number(btn.dataset.restore)] },
        });
        toast(r.note ?? '已恢复');
        await refreshSettings({ reloadConfig: false });
      } catch (err) {
        toast(`恢复失败：${err.message}`, true);
      }
    });
  });

  $('#setRestoreAll')?.addEventListener('click', async () => {
    const n = (settingsState.exclusions ?? []).length;
    if (!n) return;
    const okRestore = await askConfirm({
      title: `恢复全部 ${n} 张已移除的专辑`,
      text: '恢复后，这些专辑会在重新扫描音乐库时重新入库。'
        + '（它们的标签、收藏等库内记录在移除时已经删除，无法恢复。）',
      okLabel: '全部恢复',
    });
    if (!okRestore) return;
    try {
      const r = await api('/api/exclusions/restore', { method: 'POST', body: { all: true } });
      toast(r.note ?? '已恢复');
      await refreshSettings({ reloadConfig: false });
    } catch (err) {
      toast(`恢复失败：${err.message}`, true);
    }
  });

  $$('#settingsBody [data-tray-pick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const on = btn.dataset.trayPick === '1';
      $$('#settingsBody [data-tray-pick]').forEach((b) => b.classList.toggle('is-active', b === btn));
      saveDesktopSetting(on);
    });
  });
  $('#setPrefetch')?.addEventListener('change', (e) => {
    const note = PREFETCH_LABELS.find((p) => p.id === e.target.value)?.note ?? '';
    const el = $('#setPrefetchNote');
    if (el) el.textContent = note;
  });

  // 深浅模式：点了立刻切换（先切高亮再发请求，避免异步造成的高亮滞后）
  $$('#settingsBody [data-mode-pick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.modePick;
      $$('#settingsBody [data-mode-pick]').forEach((b) => b.classList.toggle('is-active', b === btn));
      saveAppearance({ mode }).then(() => refreshSettings());
    });
  });

  $$('#settingsBody [data-theme-pick]').forEach((card) => {
    const pick = () => {
      // 先把高亮切过去再发请求：refreshSettings 是异步的，否则会看到「高亮没跟上」
      $$('#settingsBody [data-theme-pick]').forEach((c) => c.classList.toggle('is-active', c === card));
      saveAppearance({ theme: card.dataset.themePick }).then(() => refreshSettings());
    };
    card.addEventListener('click', pick);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
    });
  });

  const opacity = $('#setBgOpacity');
  opacity?.addEventListener('input', () => {
    const v = Number(opacity.value);
    $('#setBgOpacityVal').textContent = `${v}%`;
    // 拖动时只改预览不写盘；松手才保存
    document.documentElement.style.setProperty('--bg-alpha-pct', `${v}%`);
  });
  opacity?.addEventListener('change', () => saveAppearance({ bgOpacity: Number(opacity.value) }));

  $('#setBgPick')?.addEventListener('click', async () => {
    // 优先用系统原生选图框；不可用时退回浏览器文件选择
    try {
      const r = await api('/api/dialog/image', { method: 'POST', body: {} });
      if (r.cancelled) return;
      if (r.ok && r.path) { await saveAppearance({ bgImage: r.path }); await refreshSettings(); return; }
      throw new Error(r.error ?? '未取到图片路径');
    } catch {
      $('#settingsBgFileInput').click();
    }
  });

  $('#setBgClear')?.addEventListener('click', async () => {
    await saveAppearance({ bgImage: null });
    await refreshSettings();
  });

  $('#setCacheDirPick')?.addEventListener('click', async () => {
    try {
      const r = await api('/api/dialog/folder', { method: 'POST', body: {} });
      if (r.cancelled) return;
      if (r.ok && r.path) $('#setCacheDir').value = r.path;
      else toast(r.error ?? '未能选择目录', true);
    } catch (err) {
      toast(`打开目录选择框失败：${err.message}`, true);
    }
  });

  $('#setClearCache')?.addEventListener('click', async () => {
    const used = fmtBytes(settingsState.cache?.bytes ?? 0);
    try {
      const r = await api('/api/archive/cache/clear', { method: 'POST', body: {} });
      if (r.result?.ok) toast(`缓存已清空：释放 ${fmtBytes(r.result.bytes)}（原有 ${used}）`);
      else toast(r.result?.error ?? '清空失败', true);
    } catch (err) {
      toast(`清空缓存失败：${err.message}`, true);
    }
    await refreshSettings({ reloadConfig: false });
  });
}

/** 纯浏览器模式的兜底：把图片转成 data URL 存进配置 */
function bindSettingsBgFile() {
  $('#settingsBgFileInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      toast('背景图请控制在 8 MB 以内（过大会拖慢界面加载）', true);
      return;
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('读取图片失败'));
      fr.readAsDataURL(file);
    }).catch((err) => { toast(err.message, true); return null; });
    if (!dataUrl) return;
    await saveAppearance({ bgImage: dataUrl });
    await refreshSettings();
  });
}

function bindSettingsEvents() {
  $('#settingsBtn')?.addEventListener('click', () => (settingsOpen() ? closeSettings() : openSettings()));
  $('#settingsCloseBtn')?.addEventListener('click', closeSettings);
  $('#settingsBackdrop')?.addEventListener('click', closeSettings);
  $('#settingsSaveBtn')?.addEventListener('click', saveArchiveSettings);
  $('#settingsResetBtn')?.addEventListener('click', async () => {
    try {
      const { config } = await api('/api/config', {
        method: 'POST',
        body: {
          archive: { prefetch: 'next', maxBytes: 20 * GIB, cacheDir: '' },
          appearance: {
            theme: 'midnight', mode: 'dark', bgOpacity: 100, bgImage: null,
          },
        },
      });
      settingsState.config = config;
      applyAppearance(config.appearance);
      toast('已恢复默认设置');
    } catch (err) {
      toast(`恢复默认失败：${err.message}`, true);
    }
    await refreshSettings();
  });
  bindSettingsBgFile();
}

/* ==================================================================== 启动 */

(async function main() {
  try {
    bindEvents();
  } catch (err) {
    // 事件绑定失败也必须让用户看见，而不是白屏
    document.body.innerHTML = `<div style="padding:40px;color:#ff9a9a;font:14px/1.7 system-ui">
      界面初始化失败：${esc(err.message)}<br />请刷新页面；若持续出现，请查看浏览器控制台。</div>`;
    return;
  }
  // 设置：先绑事件再拉配置，保证外观在整个界面画出来之前就位（避免主题闪一下）
  bindSettingsEvents();
  await loadSettingsConfig();
  // 缓存额度也要在启动时拿到：预读取询问框要显示「缓存上限/已用」
  await loadCacheStatus();
  setPlayMode(state.playMode);
  bindColumnResize();
  applyColWidths(currentColWidths());
  $('#albumGrid').className = `album-grid size-${state.albumSize}`;
  try {
    await loadLibraries();
    // 专辑墙必须挂在一个音乐库上：先定下当前库，标签栏才知道该取哪一套标签
    ensureDefaultLibrary();
    await Promise.all([loadTagBar(), route()]);
    await updateFavoriteBadges();
    const { running, lastReport } = await api('/api/scan/status');
    if (running) {
      pollScan();
    } else if (lastReport) {
      $('#scanStatus').hidden = false;
      $('#scanBarFill').style.width = '100%';
      $('#scanPhase').textContent = `上次扫描：${new Date(lastReport.finishedAt).toLocaleString('zh-CN')}`;
      $('#scanCount').textContent = `${lastReport.added} 新增 · ${lastReport.updated} 更新`;
    }
  } catch (err) {
    toast(`初始化失败：${err.message}`, true);
  }
})();
