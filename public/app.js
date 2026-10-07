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
  tagFilter: new Set(),
  tagMode: localStorage.getItem('tagMode') || 'and',
  albumSize: localStorage.getItem('albumSize') || 'medium',
  albums: [],
  albumTotal: 0,
  albumOffset: 0,
  hasMore: false,
  tagCatalog: [],
  libraries: [],
  trackList: [],
  incomplete: { summary: null, albums: [], group: null, status: null },
  tagsView: [],
  currentAlbum: null,
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
audio.volume = Number(localStorage.getItem('volume') ?? 85) / 100;
$('#volume').value = String(Math.round(audio.volume * 100));

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

/** 渲染后决定每张封面加载缩略图还是原图（异步、不阻塞首屏） */
async function hydrateCoverThumbs(root = document) {
  if (!thumbSupported()) {
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
  const c = album.completeness;
  if (c && c.status !== 'complete') {
    const critical = c.status === 'critical';
    const tips = (c.missingDetailed ?? []).map((m) => m.label).join('、');
    parts.push(`<span class="badge ${critical ? 'is-critical' : 'is-warn'}" title="${esc(tips)}">`
      + `${critical ? '⚠ 关键缺失' : '⚠ 待完善'}</span>`);
  }
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

function albumQuery(offset) {
  const params = new URLSearchParams({
    q: state.query,
    sort: state.sort,
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (state.tagFilter.size) {
    params.set('tags', [...state.tagFilter].join(','));
    params.set('tagMode', state.tagMode);
  }
  if (state.favScope) {
    params.set('favorite', '1');
    params.set('kind', state.favScope === 'asmr' ? 'voice' : 'music');
  }
  if (state.libraryFilter) params.set('libraryId', String(state.libraryFilter));
  return `/api/albums?${params}`;
}

async function loadAlbums({ append = false } = {}) {
  const offset = append ? state.albumOffset : 0;
  const { albums, total, hasMore } = await api(albumQuery(offset));  state.albums = append ? [...state.albums, ...albums] : albums;
  state.albumTotal = total;
  state.albumOffset = state.albums.length;
  state.hasMore = hasMore;

  $('#albumGrid').className = `album-grid size-${state.albumSize}`;
  $('#albumGrid').innerHTML = state.albums.map(albumCardMarkup).join('');
  // 明确告诉用户当前筛选条件（再点一次该库可取消）
  const libName = state.libraryFilter
    ? state.libraries?.find((l) => String(l.id) === String(state.libraryFilter))?.display_name
    : null;
  const parts = [];
  if (state.favScope === 'asmr') parts.push('喜欢的ASMR');
  if (state.favScope === 'album') parts.push('喜欢的专辑');
  if (libName) parts.push(`${libName} 库`);
  if (state.query) parts.push(`搜索「${state.query}」`);
  if (state.tagFilter.size) parts.push('标签筛选');
  $('#resultCount').textContent = parts.length
    ? `${parts.join(' · ')}：${total} 张专辑`
    : `${total} 张专辑`;

  const filtered = Boolean(state.query || state.tagFilter.size || state.libraryFilter || state.favScope);
  const empty = albums.length === 0;
  $('#albumsEmpty').hidden = !empty;
  if (empty) {
    $('#emptyTitle').textContent = filtered ? '没有匹配的专辑' : '还没有音乐';
    $('#emptyText').textContent = filtered
      ? '换个关键词，或清除筛选后重试。'
      : '在左侧添加一个音乐目录，然后点击「扫描音乐库」。';
  }
  $('#loadMoreWrap').hidden = !state.hasMore;
  if (state.hasMore) {
    $('#loadMoreBtn').textContent = `加载更多（已显示 ${state.albums.length} / 共 ${total}）`;
  }
  syncSelectionUi();
  void hydrateCoverThumbs($('#albumGrid'));
}

/* ------------------------------------------------------------ 标签筛选条 */

async function loadTagBar() {
  const { tags } = await api('/api/tags');
  state.tagCatalog = tags;
  renderTagBar();
}

function renderTagBar() {
  const bar = $('#tagBar');
  bar.hidden = state.view !== 'albums';
  const top = state.tagCatalog.slice(0, 20);
  const chips = top.map((t) => `
    <button class="tag-chip ${state.tagFilter.has(t.id) ? 'is-active' : ''}" data-tag="${t.id}">
      <span class="tag-dot" style="background:${tagColor(t.color)}"></span>
      ${esc(t.name)}<span class="tag-count">${t.album_count}</span>
    </button>`).join('');

  const sizes = ['small', 'medium', 'large'];
  const sizeLabels = { small: '小', medium: '中', large: '大' };

  bar.innerHTML = `
    ${state.tagFilter.size ? '<button class="tag-chip is-clear" data-clear="1">✕ 清除筛选</button>' : ''}
    ${chips || '<span class="tag-count">还没有标签 —— 在专辑卡片或详情页点「🏷」即可创建</span>'}
    <span style="flex:1"></span>
    <span class="tag-count">封面</span>
    ${sizes.map((s) => `<button class="tag-chip ${state.albumSize === s ? 'is-active' : ''}"
       data-size="${s}">${sizeLabels[s]}</button>`).join('')}`;
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
function voiceDetailMarkup(album, data) {
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
      <div class="detail-cover">${coverMarkup(album.cover_url, album.album, album.cover_hash, { eager: true })}</div>
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
          <button class="btn" id="revealAlbumBtn">
            <svg viewBox="0 0 24 24"><path d="M3 7h5l2 2h11v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg> 打开文件夹
          </button>
          <button class="btn" id="voiceIssuesBtn">⚠ 检查问题</button>
        </div>
        <div class="wb-missing" style="margin-top:14px" id="detailTags">
          ${album.tags?.length
    ? album.tags.map((t) => `<span class="tag-pill is-on" style="border-color:${tagColor(t.color)}66">${esc(t.name)}</span>`).join('')
    : '<span class="tag-count">还没有标签</span>'}
        </div>
        <div class="voice-notes">音声专辑的名称取自文件夹，艺术家只记录在软件内，<b>不会写回音频文件</b>。</div>
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
    ${bonusHtml}`;
}

async function openAlbum(id, { push = true } = {}) {
  const data = await api(`/api/albums/${encodeURIComponent(id)}`);
  const { album, tracks } = data;

  // 音声发行走专用渲染（版本切换 + 特典分组 + 问题面板）
  if (album.is_voice) return openVoiceAlbum(data, { push });

  state.currentAlbum = { album, tracks };

  const total = tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);
  const formats = [...new Set(tracks.map((t) => (t.ext ?? '').replace('.', '').toUpperCase()).filter(Boolean))];
  const bitrates = tracks.map((t) => t.bitrate).filter(Number.isFinite);
  const avgKbps = bitrates.length ? Math.round(bitrates.reduce((a, b) => a + b, 0) / bitrates.length / 1000) : null;
  const c = album.completeness ?? { status: 'complete', missing: [], missingDetailed: [], ignored: [] };

  const tagsHtml = album.tags?.length
    ? album.tags.map((t) => `<span class="tag-pill is-on" style="border-color:${tagColor(t.color)}66">${esc(t.name)}</span>`).join('')
    : '<span class="tag-count">还没有标签</span>';

  const missingHtml = c.missingDetailed?.length
    ? c.missingDetailed.map((m) => `<span class="miss-chip ${m.level === 'required' ? 'is-critical' : ''}"
        title="${esc(m.hint ?? '')}" data-open-group="${m.key}">${esc(m.label)}</span>`).join('')
    : '<span class="miss-chip" style="background:rgba(74,217,145,.14);color:var(--ok);border-color:rgba(74,217,145,.3)">完整</span>';
  const ignoredHtml = c.ignored?.length
    ? c.ignored.map((k) => `<span class="miss-chip is-ignored" data-restore="${k}" title="点击恢复提醒">已忽略</span>`).join('')
    : '';

  $('#albumDetail').innerHTML = `
    <div class="detail-head">
      <div class="detail-cover">${coverMarkup(album.cover_url, album.album, album.cover_hash, { eager: true })}</div>
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
          <button class="btn" id="revealAlbumBtn">
            <svg viewBox="0 0 24 24"><path d="M3 7h5l2 2h11v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg> 打开文件夹
          </button>
        </div>
        <div class="wb-missing" style="margin-top:14px" id="detailTags">${tagsHtml}</div>
        <div class="wb-missing" style="margin-top:8px">${missingHtml}${ignoredHtml}</div>
        ${album.is_compilation ? '<div class="tag-count" style="margin-top:8px">已标记为合辑（豁免「缺专辑艺术家」提醒）</div>' : ''}
      </div>
    </div>
    <div class="track-table">
      ${trackTableHeader('艺术家')}
      ${tracks.map((t, i) => trackRowMarkup(t, i, { showAlbum: false })).join('')}
    </div>`;

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
    await api(`/api/albums/${album.id}/circle`, { method: 'POST', body: { circle: name } });
    toast('已保存社团（仅库内记录）');
    openAlbum(album.id, { push: false });
  });
  $('#revealAlbumBtn').addEventListener('click', () => {
    api('/api/reveal', { method: 'POST', body: { path: tracks[0]?.path } }).catch(() => {});
  });
  $$('#albumDetail [data-open-group]').forEach((el) => el.addEventListener('click', async () => {
    await api(`/api/albums/${album.id}/ignore`, { method: 'POST', body: { key: el.dataset.openGroup } });
    toast('已忽略该提醒');
    openAlbum(album.id, { push: false });
  }));
  $$('#albumDetail [data-restore]').forEach((el) => el.addEventListener('click', async () => {
    await api(`/api/albums/${album.id}/ignore`, {
      method: 'POST', body: { key: el.dataset.restore, restore: true },
    });
    toast('已恢复该提醒');
    openAlbum(album.id, { push: false });
  }));

  showView('albumDetail');
  if (push) history.pushState({ id }, '', `#/album/${id}`);
  highlightPlayingRow();
}

/** 音声发行详情：渲染 + 事件（版本切换播放 / 视频弹窗 / 问题面板） */
async function openVoiceAlbum(data, { push = true } = {}) {
  const { album } = data;
  state.currentAlbum = { album, tracks: data.tracks };

  $('#albumDetail').innerHTML = voiceDetailMarkup(album, data);

  /** 把某个版本的轨道行变成可播放队列 */
  const queueFromRows = (rows) => rows.map((r) => {
    const v = r.variants.find((x) => x.track_id === r.preferred_track_id) ?? r.variants[0];
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
    await api(`/api/albums/${album.id}/voice-artist`, { method: 'POST', body: { artist: name } });
    toast('已保存（仅库内记录）');
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
    const n = (res.propagated ?? []).length;
    toast(n ? `已保存，并自动套用到 ${n} 张同名社团的作品` : '已保存社团（仅库内记录）');
    openAlbum(album.id, { push: false });
  });
  $('#adoptArtistBtn')?.addEventListener('click', async () => {
    const res = await api(`/api/albums/${album.id}/artist-decision`, {
      method: 'POST', body: { decision: 'adopted' },
    });
    const n = (res.propagated ?? []).length;
    toast(n ? `已采用该艺术家，并自动套用到 ${n} 张作品` : '已采用该艺术家（仅软件显示）');
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
      const q = queueFromRows([{ ...rowData, preferred_track_id: Number(btn.dataset.track) }]);
      playQueue(q, 0, { cover: album.cover_url, label: `音声《${album.album}》` });
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

/* ============================================================ 视图：待完善 */

async function loadIncomplete() {
  const params = new URLSearchParams({ limit: '400' });
  if (state.incomplete.group) params.set('group', state.incomplete.group);
  if (state.incomplete.status) params.set('status', state.incomplete.status);
  const data = await api(`/api/incomplete?${params}`);
  state.incomplete.summary = data.summary;
  state.incomplete.albums = data.albums;

  const summary = data.summary;
  const badge = $('#incompleteBadge');
  badge.hidden = !summary.incomplete;
  badge.textContent = String(summary.incomplete);

  const groups = summary.groups.map((g) => `
    <button class="wb-group ${state.incomplete.group === g.key ? 'is-active' : ''}" data-group="${g.key}">
      <div class="wb-count">${g.count}</div>
      <div class="wb-label">${esc(g.label)}</div>
      <div class="wb-level ${g.level === 'required' ? 'is-critical' : ''}">
        ${g.level === 'required' ? '关键缺失' : '建议补全'}
      </div>
    </button>`).join('');

  const items = state.incomplete.albums.map((a) => `
    <div class="wb-item">
      <div class="wb-cover" style="${a.cover_hash ? `background-image:url('/api/cover/${a.cover_hash}')` : ''}"></div>
      <div class="wb-main">
        <div class="wb-title">${esc(a.album)}</div>
        <div class="wb-artist">${esc(a.album_artist)}${a.year ? ` · ${a.year}` : ''}</div>
      </div>
      <div class="wb-missing">
        ${a.missingDetailed.map((m) => `<span class="miss-chip ${m.level === 'required' ? 'is-critical' : ''}"
            title="${esc(m.hint ?? '')}">${esc(m.label)}</span>`).join('')}
      </div>
      <button class="btn btn-ghost" data-open-album="${a.id}">打开</button>
    </div>`).join('');

  $('#incompletePanel').innerHTML = `
    <div class="wb-head">
      <h2>待完善工作台</h2>
      <span class="wb-sub">
        共 ${summary.total} 张专辑 · <span style="color:var(--ok)">完整 ${summary.complete}</span> ·
        <span style="color:var(--warn)">建议补全 ${summary.advisory}</span> ·
        <span style="color:#ff9a9a">关键缺失 ${summary.critical}</span>
      </span>
    </div>
    <div class="wb-groups">${groups || '<div class="wb-sub">库里没有待完善专辑 🎉</div>'}</div>
    <div style="display:flex;gap:8px;align-items:center">
      <button class="tag-chip ${!state.incomplete.group ? 'is-active' : ''}" data-group="">全部</button>
      ${state.incomplete.group ? '<button class="tag-chip" data-group-clear="1">✕ 清除筛选</button>' : ''}
    </div>
    <div class="wb-list">${items || '<div class="wb-sub">没有符合条件的专辑</div>'}</div>
    <p class="wb-sub">提示：忽略某项后可在专辑详情页点「已忽略」恢复；编辑与写回能力将在 V2.2 提供。</p>`;
}

/* ============================================================== 视图：标签 */

async function loadTagsView() {
  const { tags } = await api('/api/tags');
  state.tagsView = tags;
  state.tagCatalog = tags;

  const rows = tags.map((t) => `
    <div class="tag-row" data-tag-id="${t.id}">
      <span class="tag-swatch" style="background:${tagColor(t.color)}" data-color="${t.id}"
            title="点击切换颜色"></span>
      <span class="tag-name" data-name="${t.id}">${esc(t.name)}</span>
      <span class="tag-stats">${t.album_count} 张专辑 · ${t.track_count} 首曲目</span>
      <span class="tag-actions">
        <button class="icon-btn" data-pin="${t.id}" title="${t.pinned ? '取消置顶' : '置顶'}"
          style="${t.pinned ? 'color:var(--accent-2)' : ''}">
          <svg viewBox="0 0 24 24"><path d="M12 17v5M9 3h6l-1 7 3 3v2H7v-2l3-3z"/></svg>
        </button>
        <button class="icon-btn" data-rename="${t.id}" title="重命名">
          <svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
        </button>
        <button class="icon-btn" data-merge="${t.id}" title="合并到其他标签">
          <svg viewBox="0 0 24 24"><path d="M7 3v6a4 4 0 0 0 4 4h6M17 9l3 4-3 4"/><path d="M7 21v-6"/></svg>
        </button>
        <button class="icon-btn" data-delete="${t.id}" title="删除标签（不删专辑）">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </span>
    </div>`).join('');

  $('#tagsPanel').innerHTML = `
    <div class="wb-head">
      <h2>标签</h2>
      <span class="wb-sub">${tags.length} 个标签 · 点击名字重命名，点击色块换色</span>
    </div>
    <div style="display:flex;gap:8px">
      <input type="text" id="newTagName" placeholder="新建标签…" style="background:#0c0c11;border:1px solid var(--line-strong);border-radius:10px;padding:9px 12px;color:var(--fg);outline:none;flex:1;max-width:320px" />
      <button class="btn" id="newTagBtn">新建</button>
    </div>
    <div class="wb-list">${rows || '<div class="wb-sub">还没有标签。可以在专辑卡片或详情页点「🏷」创建第一个。</div>'}</div>`;

  // 这两个元素随视图动态生成，必须在这里绑定（不能放在 bindEvents 里）
  const createFromInput = async () => {
    const input = $('#newTagName');
    if (!input.value.trim()) return;
    try {
      await api('/api/tags', { method: 'POST', body: { name: input.value.trim() } });
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
  const { stats, completeness, lastBackupAt } = await api('/api/stats');
  const thumbs = await thumbCacheStats();
  const coverUsage = await api('/api/maintenance/usage').catch(() => null);
  const jobs = await api('/api/jobs?limit=8').catch(() => ({ jobs: [] }));
  const writerSupport = await api('/api/writer/support').catch(() => null);
  const maxFormat = Math.max(1, ...stats.byFormat.map((f) => f.n));
  const maxArtist = Math.max(1, ...stats.topArtists.map((a) => a.albums));
  const maxTag = Math.max(1, ...(stats.topTags ?? []).map((t) => t.albums || 1));
  const completeRate = completeness.total
    ? Math.round((completeness.complete / completeness.total) * 100) : 0;

  $('#statsPanel').innerHTML = `
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-value">${stats.albums}</div><div class="stat-label">专辑</div></div>
      <div class="stat-card"><div class="stat-value">${stats.tracks}</div><div class="stat-label">曲目</div></div>
      <div class="stat-card"><div class="stat-value">${stats.artists}</div><div class="stat-label">艺术家</div></div>
      <div class="stat-card"><div class="stat-value">${stats.tags}</div><div class="stat-label">标签</div></div>
      <div class="stat-card"><div class="stat-value">${esc(fmtLong(stats.total_duration))}</div><div class="stat-label">总时长</div></div>
      <div class="stat-card"><div class="stat-value">${esc(fmtBytes(stats.total_size))}</div><div class="stat-label">占用空间</div></div>
      <div class="stat-card"><div class="stat-value">${completeRate}%</div><div class="stat-label">信息完整度</div></div>
      <div class="stat-card"><div class="stat-value" style="color:var(--warn)">${completeness.incomplete}</div>
        <div class="stat-label">待完善专辑</div></div>
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
          标签、库显示名、提醒豁免属于<b>用户资产</b>，删除索引不会自动重建它们。<br />
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

const tagDialogState = { albumIds: [], selected: new Set(), initial: new Set(), bulk: false, all: [] };

async function openTagDialog(albumIds, currentTags = [], { bulk = false } = {}) {
  tagDialogState.albumIds = albumIds;
  tagDialogState.bulk = bulk;
  tagDialogState.selected = new Set(currentTags.map((t) => t.id));
  tagDialogState.initial = new Set(currentTags.map((t) => t.id));

  const { tags } = await api('/api/tags');
  tagDialogState.all = tags;

  $('#tagDlgTitle').textContent = bulk ? `为 ${albumIds.length} 张专辑打标签` : '为专辑添加标签';
  $('#tagDlgHint').textContent = bulk
    ? '选择标签后点「追加」加入这些专辑。'
    : '输入标签名回车即可创建，或点击已有标签切换选中。';
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
    const { tag } = await api('/api/tags', { method: 'POST', body: { name } });
    tagDialogState.all = (await api('/api/tags')).tags;
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
  const list = $('#libraryList');
  list.innerHTML = libraries.map((l) => `
    <div class="library-item${String(state.libraryFilter) === String(l.id) ? ' is-active' : ''}"
         data-id="${l.id}" title="${esc(l.path)}\n点击只看这个音乐库的专辑">
      <span class="lib-path" data-name-slot="${l.id}">${esc(l.display_name)}</span>
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
        await Promise.all([loadLibraries(), loadTagBar(), refreshCurrent()]);
        const report = lastReport ?? s;
        toast(`扫描完成：新增 ${report.added}，更新 ${report.updated}，`
          + `清理 ${report.removed ?? 0}，封面 ${report.coverExtracted ?? 0}`);
        if (report.failed) toast(`有 ${report.failed} 个文件处理失败`, true);
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

const VIEWS = ['Albums', 'AlbumDetail', 'Tracks', 'Incomplete', 'Tags', 'Stats'];

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
  incomplete: 'Incomplete',
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
  $('#tagBar').hidden = !isAlbumWall;
  $('#bulkBar').hidden = !(isAlbumWall && state.selecting);
  $('#selectModeBtn').hidden = !isAlbumWall;
  if (isAlbumWall) renderTagBar();
}

async function refreshCurrent() {
  if (state.view === 'albums') await loadAlbums();
  else if (state.view === 'albumDetail' && state.currentAlbum) {
    await openAlbum(state.currentAlbum.album.id, { push: false });
  } else if (state.view === 'tracks') await loadTracks();
  else if (state.view === 'incomplete') await loadIncomplete();
  else if (state.view === 'tags') await loadTagsView();
  else if (state.view === 'stats') await loadStats();
  await refreshIncompleteBadge();
}

async function refreshIncompleteBadge() {
  try {
    const { summary } = await api('/api/incomplete?limit=1');
    const badge = $('#incompleteBadge');
    badge.hidden = !summary.incomplete;
    badge.textContent = String(summary.incomplete);
  } catch { /* 角标失败不影响主流程 */ }
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
  pendingCover: null, confirmed: false,
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

async function openEditDrawer(albumId) {
  const { album, tracks } = await api(`/api/albums/${encodeURIComponent(albumId)}`);
  editState.albumId = albumId;
  editState.album = album;
  editState.tracks = tracks;
  editState.dirty.clear();
  editState.cleared.clear();
  editState.pendingCover = null;
  editState.confirmed = false;
  renderEditDrawer();
  $('#drawerBackdrop').hidden = false;
  $('#editDrawer').hidden = false;
}

function closeEditDrawer() {
  $('#editDrawer').hidden = true;
  $('#drawerBackdrop').hidden = true;
  editState.albumId = null;
}

function fieldMarkup({ key, label, type, value, hint }) {
  const cleared = editState.cleared.has(key);
  return `
    <div class="field">
      <label>${esc(label)}${hint ? ` <span style="color:var(--fg-faint)">· ${esc(hint)}</span>` : ''}</label>
      <div class="field-row">
        <input type="${type}" data-field="${key}" value="${cleared ? '' : esc(value)}"
               ${cleared ? 'class="is-cleared" disabled' : ''} />
        <button class="clear-btn ${cleared ? 'is-on' : ''}" data-clear="${key}"
                title="${cleared ? '取消清空' : '清空该字段（不点则保持原值）'}">
          ${cleared ? '已清除' : '清除'}
        </button>
      </div>
    </div>`;
}

function renderEditDrawer() {
  const a = editState.album;
  const tracks = editState.tracks;
  const coverUrl = a.cover_url;
  const pending = editState.pendingCover;

  $('#editBody').innerHTML = `
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
            <label><input type="radio" name="coverMode" value="embedded" checked />
              写入每首曲目的内嵌封面（跨软件可见，体积增加）</label>
            <label><input type="radio" name="coverMode" value="folder" />
              只写目录 cover.jpg（省空间，拷走单文件会丢）</label>
            <label><input type="radio" name="coverMode" value="db" />
              仅记录在软件内（零风险，重建索引会丢）</label>
          </div>
        </div>
      </div>
    </div>

    <div class="drawer-section">
      <h4>专辑信息（写入全部 ${tracks.length} 首曲目）</h4>
      ${ALBUM_FIELDS.slice(0, 2).map((f) => fieldMarkup({
        ...f, value: originalValue(f.key),
      })).join('')}
      <div class="two-fields" style="margin-top:10px">
        ${ALBUM_FIELDS.slice(2).map((f) => fieldMarkup({ ...f, value: originalValue(f.key) })).join('')}
      </div>
    </div>

    <div class="drawer-section">
      <h4>曲目（只改填写的那一首）</h4>
      ${tracks.map((t) => `
        <div class="track-edit-row">
          <span class="idx">${t.track_no ?? ''}</span>
          <input type="text" data-track="${t.id}" data-track-field="title"
                 value="${esc(trackOriginal(t, 'title'))}" placeholder="曲名" />
          <input type="number" data-track="${t.id}" data-track-field="trackNo"
                 value="${esc(trackOriginal(t, 'trackNo'))}" placeholder="音轨" />
        </div>`).join('')}
    </div>

    <div class="drawer-section">
      <h4>安全说明</h4>
      <p class="hint" style="font-size:12.5px;line-height:1.7;margin:0">
        保存时会先把原文件复制到工作副本，写入并回读校验后才原子替换；
        原文件会完整保留在音乐库根目录的 <code>.lam-undo/</code> 下，可一键撤销。
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
    $('#editImpact').classList.remove('is-error');
    $('#editImpact').innerHTML = `将修改 <b>${s.files}</b> 个文件`
      + `${s.unsupported ? `（其中 <b>${s.unsupported}</b> 个格式不支持写回，只会更新数据库）` : ''}`
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
    history.pushState({}, '', view === 'albums' ? '#/' : `#/${view}`);
    // 进入收藏视图前清掉库筛选，否则「Album 库」的筛选会把收藏里的 ASMR 藏起来
    if (view === 'favasmr' || view === 'favalbum') state.libraryFilter = null;
    if (view === 'albums') { state.favScope = null; state.trackFavOnly = false; loadAlbums(); }
    else if (view === 'favasmr') { state.favScope = 'asmr'; state.trackFavOnly = false; loadLibraries(); loadAlbums(); }
    else if (view === 'favalbum') { state.favScope = 'album'; state.trackFavOnly = false; loadLibraries(); loadAlbums(); }
    else if (view === 'favtracks') { state.trackFavOnly = true; loadTracks(); }
    else if (view === 'tracks') { state.trackFavOnly = false; loadTracks(); }
    else if (view === 'incomplete') loadIncomplete();
    else if (view === 'tags') loadTagsView();
    else loadStats();
    showView(view);
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
      if (state.tagFilter.has(id)) state.tagFilter.delete(id);
      else state.tagFilter.add(id);
      renderTagBar();
      loadAlbums();
      return;
    }
    if (e.target.closest('[data-clear]')) {
      state.tagFilter.clear();
      renderTagBar();
      loadAlbums();
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
        toast(`已为 ${res.updated} 张音声发行填写${isArtist ? '艺术家' : '社团'}`
          + (skipped ? `，跳过 ${skipped} 张普通专辑` : ''));
      }
      state.selected.clear();
      state.selecting = false;
      await loadAlbums();
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
    if (e.target.closest('#pickCoverBtn')) $('#coverFileInput').click();
    else if (e.target.closest('#applyCoverBtn')) applyCover();
    else if (e.target.closest('#removeCoverBtn')) removeCover();
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

  $('#incompletePanel').addEventListener('click', (e) => {
    const group = e.target.closest('[data-group]');
    if (group) {
      state.incomplete.group = group.dataset.group || null;
      loadIncomplete();
      return;
    }
    if (e.target.closest('[data-group-clear]')) {
      state.incomplete.group = null;
      loadIncomplete();
      return;
    }
    const open = e.target.closest('[data-open-album]');
    if (open) {
      const id = Number(open.dataset.openAlbum);
      history.pushState({}, '', `#/album/${id}`);
      openAlbum(id, { push: false });
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
      hint: '输入目标标签名，该标签下的专辑会全部转到目标标签',
      placeholder: '目标标签名',
    });
    if (target === null) return;
      if (!target) return;
      const targetTag = state.tagsView.find((t) => t.name.toLowerCase() === target.trim().toLowerCase());
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
      if (String(state.libraryFilter) === String(id)) state.libraryFilter = null;
      await loadLibraries();
      refreshCurrent();
      return;
    }

    // 点击音乐库条目本身 → 只看该库的专辑（再点一次取消筛选）
    const item = e.target.closest('.library-item');
    if (!item) return;
    const id = Number(item.dataset.id);
    state.libraryFilter = state.libraryFilter === id ? null : id;
    if (state.libraryFilter === null) toast('已显示全部音乐库');
    else toast(`只看「${item.querySelector('.lib-path')?.textContent ?? ''}」`);
    // 在收藏视图里点库：按该库筛选（收藏 + 库 同时生效）
    state.favScope = null;
    state.trackFavOnly = false;
    await loadLibraries();
    if (!ALBUM_WALL_VIEWS.includes(state.view)) showView('albums');
    loadAlbums();
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
  $('#npClose').addEventListener('click', () => setNowPlaying(false));

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
    audio.volume = Number(e.target.value) / 100;
    localStorage.setItem('volume', e.target.value);
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

  window.addEventListener('popstate', route);
}

/* ================================================================ 路由 */

async function route() {
  const hash = location.hash.replace(/^#/, '');
  if (hash.startsWith('/album/')) {
    await openAlbum(Number(hash.slice('/album/'.length)), { push: false });
    return;
  }
  if (hash === '/tracks') { showView('tracks'); await loadTracks(); return; }
  if (hash === '/incomplete') { showView('incomplete'); await loadIncomplete(); return; }
  if (hash === '/tags') { showView('tags'); await loadTagsView(); return; }
  if (hash === '/stats') { showView('stats'); await loadStats(); return; }
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

const settingsState = { config: null, cache: null };

const bgImageUrl = (p) => (p ? `/api/local-image?path=${encodeURIComponent(p)}` : '');

/**
 * 外观即时套用：只写 CSS 变量，不重启动、不刷新。
 * 底色用 color-mix 与 transparent 混合，从而支持背景透明度。
 */
function applyAppearance(appearance) {
  const a = appearance ?? { theme: 'midnight', bgOpacity: 100, bgImage: null };
  const root = document.documentElement;
  root.dataset.theme = a.theme || 'midnight';
  const pct = Math.min(100, Math.max(0, Number(a.bgOpacity)));
  root.style.setProperty('--bg-alpha-pct', `${Number.isFinite(pct) ? pct : 100}%`);

  if (a.bgImage) {
    root.style.setProperty('--bg-image', `url("${bgImageUrl(a.bgImage)}")`);
    // 有背景图时侧栏也跟随透明；否则「中间透、两边实」会很割裂
    root.style.setProperty('--sidebar-bg',
      'color-mix(in srgb, var(--bg-l0) var(--bg-alpha-pct), transparent)');
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

function settingsMarkup() {
  const cfg = settingsState.config ?? {};
  const arch = cfg.archive ?? { prefetch: 'next', cacheDir: '', maxBytes: 20 * GIB };
  const app = cfg.appearance ?? { theme: 'midnight', bgOpacity: 100, bgImage: null };
  const cache = settingsState.cache ?? {};

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
  `;
}

function renderSettings() {
  const body = $('#settingsBody');
  if (!body) return;
  body.innerHTML = settingsMarkup();
  bindSettingsBody();
}

async function refreshSettings({ reloadConfig = true } = {}) {
  if (reloadConfig || !settingsState.config) await loadSettingsConfig();
  await loadCacheStatus();
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

/** 设置抽屉内控件的事件（每次重绘都要重新绑） */
function bindSettingsBody() {
  $('#setPrefetch')?.addEventListener('change', (e) => {
    const note = PREFETCH_LABELS.find((p) => p.id === e.target.value)?.note ?? '';
    const el = $('#setPrefetchNote');
    if (el) el.textContent = note;
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
          appearance: { theme: 'midnight', bgOpacity: 100, bgImage: null },
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
    await Promise.all([loadLibraries(), loadTagBar()]);
    await route();
    await refreshIncompleteBadge();
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
