/**
 * 图标接入验证：
 *  1) build/icon.ico 含全部 Windows 常用尺寸，且是有效 ICO
 *  2) build/icon.png 为 256×256 RGBA
 *  3) 界面侧栏品牌标与网页图标已换成新图标
 *  4) electron-builder 指向 build/icon.ico
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const API = 'http://127.0.0.1:8799';
const CDP = 'http://127.0.0.1:9360';

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass += 1; console.log(`  PASS  ${n}${e ? `  (${e})` : ''}`); } else { fail += 1; console.log(`  FAIL  ${n}${e ? `  (${e})` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n— 图标文件 —');
const icoPath = path.join(ROOT, 'build', 'icon.ico');
const pngPath = path.join(ROOT, 'build', 'icon.png');
ok('build/icon.ico 存在', fs.existsSync(icoPath), `${(fs.statSync(icoPath).size / 1024).toFixed(1)} KB`);
ok('build/icon.png 存在', fs.existsSync(pngPath), `${(fs.statSync(pngPath).size / 1024).toFixed(1)} KB`);

// 解析 ICO 头，读出内含尺寸（不依赖第三方库）
const buf = fs.readFileSync(icoPath);
const icoSizes = [];
if (buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1) {
  const count = buf.readUInt16LE(4);
  for (let i = 0; i < count; i += 1) {
    const off = 6 + i * 16;
    const w = buf[off] === 0 ? 256 : buf[off];
    icoSizes.push(w);
  }
}
ok('ICO 头有效且含多个尺寸', icoSizes.length >= 5, icoSizes.sort((a, b) => a - b).join(', '));
for (const need of [16, 32, 48, 256]) {
  ok(`ICO 含 ${need}px`, icoSizes.includes(need));
}

// PNG 头校验
const p = fs.readFileSync(pngPath);
const isPng = p.subarray(1, 4).toString() === 'PNG';
const w = p.readUInt32BE(16); const h = p.readUInt32BE(20);
ok('icon.png 是有效 PNG 且为 256×256', isPng && w === 256 && h === 256, `${w}×${h}`);

// electron-builder 配置
const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
ok('electron-builder 指向 build/icon.ico', /icon:\s*build\/icon\.ico/.test(yml),
  (yml.match(/icon:.*/) ?? [''])[0].trim());

// electron 主进程设置了窗口图标
const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.cjs'), 'utf8');
ok('主进程为窗口设置了图标', /icon:\s*appIconPath\(\)/.test(main));

console.log('\n— 界面接入 —');
for (const f of ['icon.png', 'icon-64.png', 'icon-32.png']) {
  const fp = path.join(ROOT, 'public', f);
  ok(`public/${f} 存在`, fs.existsSync(fp), fs.existsSync(fp) ? `${(fs.statSync(fp).size / 1024).toFixed(1)} KB` : '');
}
for (const url of ['/icon-32.png', '/icon-64.png', '/icon.png']) {
  const r = await fetch(API + url);
  ok(`${url} 可访问`, r.status === 200 && r.headers.get('content-type')?.includes('png'), `HTTP ${r.status}`);
}

const html = await (await fetch(`${API}/`)).text();
ok('网页图标不再使用月亮 emoji', !html.includes('🌙') && !html.includes('image/svg+xml'));
ok('侧栏品牌标使用新图标', /class="brand-mark"[^>]*src="\/icon-64\.png"/.test(html));
ok('旧的纯色方块标已移除', !html.includes('brand-dot'));

// 浏览器端确认图片真的加载成功
const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /^https?:\/\//.test(t.url ?? ''));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, x) => { ws.onopen = r; ws.onerror = x; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { resolve } = pending.get(m.id); pending.delete(m.id); resolve(m.result); }
};
const send = (method, params = {}) => {
  id += 1;
  return new Promise((res) => { pending.set(id, { resolve: res }); ws.send(JSON.stringify({ id, method, params })); });
};
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result.value;

await send('Page.enable'); await send('Runtime.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(3800);
const ui = await ev(`(async () => {
  const img = document.querySelector('.brand-mark');
  await img?.decode?.().catch(() => {});
  return {
    tag: img?.tagName, natural: [img?.naturalWidth, img?.naturalHeight],
    complete: img?.complete, renderedW: Math.round(img?.getBoundingClientRect().width ?? 0),
    favicons: [...document.querySelectorAll('link[rel="icon"]')].map(l => l.getAttribute('href')),
  };
})()`);
ok('品牌标图片加载成功（非破图）', ui.complete === true && ui.natural[0] === 64 && ui.natural[1] === 64,
  `${ui.tag} ${ui.natural.join('×')} 显示 ${ui.renderedW}px`);
ok('网页图标指向 PNG 文件', ui.favicons.every((h) => h?.endsWith('.png')), ui.favicons.join(', '));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close();
process.exit(fail ? 1 : 0);
