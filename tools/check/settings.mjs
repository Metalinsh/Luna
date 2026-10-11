/**
 * 设置界面验证（⚙ 位置、压缩包设置、外观设置、提醒文案）。
 *
 * 断言不与别处重复：
 *   - ZIP 解析细节      → test/zip-reader.test.mjs
 *   - 压缩包入库与角标  → check/archive.mjs
 *   - 本脚本只验「设置面板本身」以及它对外观/提醒的即时影响。
 *
 * 只读：不动音乐库，也不改压缩包；设置会被改回默认值（结束时还原）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.LUNA_BASE || 'http://127.0.0.1:8799';
const PORT = 9344;
const PROFILE = path.join(process.env.TEMP, `lam-settings-ui-${Date.now()}`);
const SHOTS = path.join(process.cwd(), 'screenshots');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${name}${extra ? `  (${extra})` : ''}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${extra ? `  (${extra})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!EDGE) { console.error('未找到 Microsoft Edge，无法运行界面检查。'); process.exit(1); }

/* ------------------------------------------------------------ 接口层前置 */

const cfg0 = (await (await fetch(`${BASE}/api/config`)).json()).config;
if (!cfg0?.archive || !cfg0?.appearance) {
  console.error('✗ /api/config 未返回 archive / appearance 段，后端版本可能过旧。');
  process.exit(1);
}

const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--disable-gpu', '--window-size=1500,950', 'about:blank',
], { stdio: 'ignore' });

async function connect() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
        .find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 等待 */ }
    await sleep(300);
  }
  throw new Error('无法连接浏览器调试端口');
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }

  static async open() {
    const ws = new WebSocket(await connect());
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new Cdp(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && cdp.pending.has(m.id)) {
        const { resolve, reject } = cdp.pending.get(m.id);
        cdp.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      }
    };
    return cdp;
  }

  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败');
    return r.result.value;
  }

  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(path.join(SHOTS, file), Buffer.from(r.data, 'base64'));
  }
}

const cdp = await Cdp.open();
try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: BASE });
  await sleep(2600);
  await cdp.eval(`(() => { window.__err = []; window.addEventListener('error', e => window.__err.push(String(e.message))); return true; })()`);

  console.log('\n— ⚙ 按钮位置 —');
  const gear = await cdp.eval(`(() => {
    const b = document.querySelector('#settingsBtn');
    if (!b) return null;
    const br = b.getBoundingClientRect();
    const mark = document.querySelector('.brand-mark').getBoundingClientRect();
    const brand = document.querySelector('.brand').getBoundingClientRect();
    const mid = (r) => r.top + r.height / 2;
    return {
      inBrand: document.querySelector('.brand').contains(b),
      dCenter: Math.abs(mid(br) - mid(mark)),
      dRight: Math.abs(brand.right - br.right),
      title: b.getAttribute('title'),
      bg: getComputedStyle(b).backgroundColor,
    };
  })()`);
  ok('⚙ 按钮存在且在 brand 容器内', Boolean(gear?.inBrand));
  ok('垂直方向与品牌图标居中对齐', gear && gear.dCenter <= 1.5, `差 ${gear?.dCenter?.toFixed(2)}px`);
  ok('水平方向右对齐', gear && gear.dRight <= 8, `距 brand 右缘 ${gear?.dRight?.toFixed(0)}px`);
  ok('title 为「设置」', gear?.title === '设置', gear?.title);
  await cdp.shot('v11-settings-btn.png');

  console.log('\n— 设置面板结构 —');
  await cdp.eval(`document.querySelector('#settingsBtn').click()`);
  await sleep(900);
  const panel = await cdp.eval(`(() => ({
    open: !document.querySelector('#settingsDrawer').hidden,
    backdrop: !document.querySelector('#settingsBackdrop').hidden,
    sections: [...document.querySelectorAll('#settingsBody .set-sec > h4')].map((h) => h.textContent.replace(/\\s+/g,' ').trim()),
    prefetch: [...document.querySelectorAll('#setPrefetch option')].map((o) => [o.value, o.textContent.trim()]),
    prefetchValue: document.querySelector('#setPrefetch')?.value,
    maxGb: document.querySelector('#setMaxGb')?.value,
    cacheDir: document.querySelector('#setCacheDir')?.value,
    hasDirPick: Boolean(document.querySelector('#setCacheDirPick')),
    hasClear: Boolean(document.querySelector('#setClearCache')),
    hasBar: Boolean(document.querySelector('.set-bar')),
    themes: [...document.querySelectorAll('[data-theme-pick]')].map((c) => c.dataset.themePick),
    opacity: document.querySelector('#setBgOpacity')?.value,
    hasBgPick: Boolean(document.querySelector('#setBgPick')),
    hasBgClear: Boolean(document.querySelector('#setBgClear')),
    hasSave: Boolean(document.querySelector('#settingsSaveBtn')),
    hasReset: Boolean(document.querySelector('#settingsResetBtn')),
    trayPicks: [...document.querySelectorAll('[data-tray-pick]')].map((b) => [b.dataset.trayPick, b.textContent.trim()]),
    trayActive: document.querySelector('[data-tray-pick].is-active')?.dataset.trayPick ?? null,
  }))()`);
  ok('抽屉已打开且遮罩可见', panel.open && panel.backdrop);
  /*
   * 分段随版本增加：压缩包（P2）+ 外观 + 桌面 + 已移除的专辑（v1.2.2 新增）。
   * 这里断言"必需的几段都在"，而不是死等某个总数 —— 加分段不该让这条失败。
   */
  const needSections = ['压缩包', '外观', '桌面', '已移除的专辑'];
  const missing = needSections.filter((n) => !panel.sections.some((s) => String(s).includes(n)));
  ok(`设置分段包含 ${needSections.join(' + ')}`, missing.length === 0,
    missing.length ? `缺少 ${missing.join('/')}；实际 ${panel.sections.join(' / ')}` : panel.sections.join(' / '));
  ok('桌面分段提供「退出程序 / 最小化到托盘」两个选项',
    panel.trayPicks.length === 2
    && panel.trayPicks.map((p) => p[0]).join(',') === '0,1'
    && /退出|托盘/.test(panel.trayPicks.map((p) => p[1]).join('')),
    panel.trayPicks.map((p) => p[1]).join(' | '));
  ok('托盘开关有明确的当前值', ['0', '1'].includes(String(panel.trayActive)), String(panel.trayActive));
  ok('预取策略为三项（不预读取 / 仅下一首 / 专辑）',
    panel.prefetch.length === 3
    && panel.prefetch.map((p) => p[0]).join(',') === 'off,next,album',
    panel.prefetch.map((p) => p[1]).join(' | '));
  ok('缓存上限预填 20 GB', Number(panel.maxGb) === 20, panel.maxGb);
  // 不断言「必须等于默认目录」——用户可能已经改过；只断言它是个绝对路径且可用
  ok('缓存目录是绝对路径', /^[A-Za-z]:[\\/]/.test(panel.cacheDir ?? ''), panel.cacheDir);
  ok('有目录「浏览…」与「清空缓存」', panel.hasDirPick && panel.hasClear);
  ok('有缓存用量条', panel.hasBar);
  ok('三种配色方案', panel.themes.length === 3, panel.themes.join(','));
  ok('背景透明度滑块存在', panel.opacity !== undefined);
  ok('背景图可设置也可移除', panel.hasBgPick && panel.hasBgClear);
  ok('有保存与恢复默认', panel.hasSave && panel.hasReset);
  await cdp.shot('v11-settings-panel.png');

  console.log('\n— 配色即时生效 —');
  const accent0 = await cdp.eval(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
  await cdp.eval(`document.querySelector('[data-theme-pick="nebula"]').click()`);
  await sleep(800);
  const afterTheme = await cdp.eval(`({
    attr: document.documentElement.dataset.theme,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    active: document.querySelector('[data-theme-pick].is-active')?.dataset.themePick,
  })`);
  ok('data-theme 切到 nebula', afterTheme.attr === 'nebula', afterTheme.attr);
  ok('强调色真的变了', accent0 !== afterTheme.accent, `${accent0} → ${afterTheme.accent}`);
  ok('高亮跟随所选方案', afterTheme.active === 'nebula', afterTheme.active);
  const savedTheme = (await (await fetch(`${BASE}/api/config`)).json()).config.appearance.theme;
  ok('配色已自动持久化', savedTheme === 'nebula', savedTheme);

  console.log('\n— 背景透明度 —');
  await cdp.eval(`(() => {
    const r = document.querySelector('#setBgOpacity');
    r.value = '35';
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(800);
  const op = await cdp.eval(`(() => {
    const body = getComputedStyle(document.body).backgroundColor;
    // 是否带透明度：rgb()/rgba()/color(srgb … / a) 三种形式都认
    const hasAlpha = /rgba?\\([^)]*,\\s*0?\\.\\d+\\s*\\)/.test(body)
      || /\\/\\s*0?\\.\\d+\\s*\\)/.test(body);
    return {
      pct: getComputedStyle(document.documentElement).getPropertyValue('--bg-alpha-pct').trim(),
      label: document.querySelector('#setBgOpacityVal')?.textContent,
      body,
      hasAlpha,
    };
  })()`);
  ok('CSS 变量写入 35%', op.pct === '35%', op.pct);
  ok('数值标签同步', op.label === '35%', op.label);
  ok('界面底色实际带上透明度', op.hasAlpha, op.body);
  const savedOpacity = (await (await fetch(`${BASE}/api/config`)).json()).config.appearance.bgOpacity;
  ok('透明度已自动持久化', Number(savedOpacity) === 35, String(savedOpacity));

  console.log('\n— 压缩包设置：保存与分段隔离 —');
  await cdp.eval(`(() => {
    const s = document.querySelector('#setPrefetch');
    s.value = 'album'; s.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#setMaxGb').value = '6';
    return true;
  })()`);
  await cdp.eval(`document.querySelector('#settingsSaveBtn').click()`);
  await sleep(1500);
  const cfg1 = (await (await fetch(`${BASE}/api/config`)).json()).config;
  ok('预取策略落库为 album', cfg1.archive.prefetch === 'album', cfg1.archive.prefetch);
  ok('上限落库为 6 GB', Math.abs(cfg1.archive.maxBytes / 1024 ** 3 - 6) < 0.01,
    `${(cfg1.archive.maxBytes / 1024 ** 3).toFixed(2)} GB`);
  ok('保存压缩包设置未影响外观段',
    cfg1.appearance.theme === 'nebula' && Number(cfg1.appearance.bgOpacity) === 35,
    JSON.stringify(cfg1.appearance));

  console.log('\n— 深/浅色模式 —');
  const modeSegs = await cdp.eval(`[...document.querySelectorAll('[data-mode-pick]')].map((b) => b.dataset.modePick)`);
  ok('提供深色/浅色两个选项', modeSegs.join(',') === 'dark,light', modeSegs.join(','));

  /*
   * 先把模式**显式切回深色**再验翻转。
   * 不能假设"打开时就是深色"：用户平时可能把界面调成浅色并保存（实测就踩过 ——
   * 用户开着浅色模式报可见度问题），那样「切到浅色」根本不会发生颜色变化，
   * 断言会假失败。
   */
  await cdp.eval(`document.querySelector('[data-mode-pick="dark"]').click()`);
  await sleep(700);
  ok('高亮与当前模式一致（切到深色后高亮深色）',
    await cdp.eval(`document.querySelector('[data-mode-pick].is-active')?.dataset.modePick`) === 'dark',
    String(await cdp.eval(`document.querySelector('[data-mode-pick].is-active')?.dataset.modePick`)));

  const darkProbe = await cdp.eval(`(() => {
    const cs = getComputedStyle(document.documentElement);
    return { mode: document.documentElement.dataset.mode, fg: cs.getPropertyValue('--fg').trim(), mix: cs.getPropertyValue('--mix-fg').trim() };
  })()`);
  ok('深色模式生效（data-mode=dark）', darkProbe.mode === 'dark', darkProbe.mode);
  await cdp.eval(`document.querySelector('[data-mode-pick="light"]').click()`);
  await sleep(900);
  const lightProbe = await cdp.eval(`(() => {
    const cs = getComputedStyle(document.documentElement);
    const t = document.querySelector('.album-name');
    return {
      mode: document.documentElement.dataset.mode,
      fg: cs.getPropertyValue('--fg').trim(),
      mix: cs.getPropertyValue('--mix-fg').trim(),
      scheme: cs.colorScheme,
      active: document.querySelector('[data-mode-pick].is-active')?.dataset.modePick,
      textColor: t ? getComputedStyle(t).color : null,
      playerBg: getComputedStyle(document.querySelector('.player')).backgroundColor,
    };
  })()`);
  ok('切到浅色后 data-mode=light', lightProbe.mode === 'light', lightProbe.mode);
  ok('文字色由亮转暗（底色翻转）',
    darkProbe.fg !== lightProbe.fg && /rgb\(27/.test(lightProbe.textColor ?? ''),
    `${darkProbe.fg} → ${lightProbe.fg}，正文 ${lightProbe.textColor}`);
  ok('半透明叠加基色翻转为黑', lightProbe.mix.replace(/\s/g, '') === '0,0,0', lightProbe.mix);
  ok('color-scheme 变为 light（原生控件跟随）', lightProbe.scheme === 'light', lightProbe.scheme);
  ok('底部播放条不再是深色（跟随模式）',
    !/rgb\(1[0-9],\s*1[0-9],\s*2[0-9]\)/.test(lightProbe.playerBg), lightProbe.playerBg);
  ok('模式高亮跟随', lightProbe.active === 'light', lightProbe.active);
  ok('浅色模式已自动持久化',
    (await (await fetch(`${BASE}/api/config`)).json()).config.appearance.mode === 'light');

  console.log('\n— 顶部条跟随背景（不再是不透明黑条）—');
  const topbar = await cdp.eval(`(() => {
    const t = document.querySelector('.topbar');
    const m = document.querySelector('.main');
    const alphaOf = (c) => { const x = c.match(/\\/\\s*([\\d.]+)\\s*\\)/); return x ? Number(x[1]) : 1; };
    return {
      bg: getComputedStyle(t).backgroundColor,
      mainBg: getComputedStyle(m).backgroundColor,
      alpha: alphaOf(getComputedStyle(t).backgroundColor),
      sameAsMain: getComputedStyle(t).backgroundColor === getComputedStyle(m).backgroundColor,
    };
  })()`);
  ok('顶部条与主内容区同一层背景', topbar.sameAsMain === true, `${topbar.bg} vs ${topbar.mainBg}`);

  await cdp.shot('v11-settings-light.png');

  console.log('\n— 恢复默认 —');
  await cdp.eval(`document.querySelector('#settingsResetBtn').click()`);
  await sleep(1500);
  const cfg2 = (await (await fetch(`${BASE}/api/config`)).json()).config;
  ok('预取回到 next', cfg2.archive.prefetch === 'next', cfg2.archive.prefetch);
  ok('上限回到 20 GB', Math.abs(cfg2.archive.maxBytes / 1024 ** 3 - 20) < 0.01,
    `${(cfg2.archive.maxBytes / 1024 ** 3).toFixed(1)} GB`);
  ok('缓存目录回到应用根 luna_cache', /luna_cache$/i.test(cfg2.archive.cacheDir), cfg2.archive.cacheDir);
  ok('配色回到 midnight', cfg2.appearance.theme === 'midnight', cfg2.appearance.theme);
  ok('深浅模式回到 dark', cfg2.appearance.mode === 'dark', String(cfg2.appearance.mode));
  ok('透明度回到 100', Number(cfg2.appearance.bgOpacity) === 100, String(cfg2.appearance.bgOpacity));
  ok('背景图已清空', cfg2.appearance.bgImage === null, String(cfg2.appearance.bgImage));

  console.log('\n— 清空缓存 —');
  const cleared = await cdp.eval(`(async () => {
    document.querySelector('#setClearCache').click();
    await new Promise((r) => setTimeout(r, 1200));
    const t = document.querySelector('#toast');
    return { text: t?.textContent?.trim(), visible: !t?.hidden, error: t?.classList.contains('is-error') };
  })()`);
  ok('给出清空结果提示', cleared.visible && /缓存/.test(cleared.text ?? ''), cleared.text);
  ok('清空不是错误', cleared.error === false, String(cleared.error));

  console.log('\n— ESC 关闭 —');
  await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(500);
  ok('ESC 关闭设置面板', await cdp.eval(`document.querySelector('#settingsDrawer').hidden`));

  const errs = await cdp.eval('window.__err');
  ok('页面无 JS 报错', (errs ?? []).length === 0, (errs ?? []).join(' | ') || '(无)');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
} catch (err) {
  console.error('验证脚本异常：', err.message);
  fail += 1;
} finally {
  try { browser.kill(); } catch { /* 忽略 */ }
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
process.exit(fail ? 1 : 0);
