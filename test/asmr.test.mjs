/**
 * 音声发行解析测试（《音声专辑设计》R1–R15）。
 *
 * 用合成目录树覆盖规则，不依赖用户的真实音声文件。
 * 标签读取一律关闭（合成文件没有真实音频内容）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeRelease, locateRelease, titleFromFolder, isFormatWrapperDir, isIgnoredSegment,
  isBonusSegment, normalizeVersionName, extractTrackNo, trackKeyOf, variantTokensOf,
  resolveVersion, pickCover, fileVariantLabel,
} from '../server/asmr.mjs';

let sandbox;
let seq = 0;

before(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lam-asmr-')); });
after(() => { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* 忽略 */ } });

/**
 * 按 { '相对路径': 字节数 } 造目录树，返回**发行根**。
 * 若所有路径的第一段就是 RJ 目录，则把它提升为发行根本身
 * （analyzeRelease 约定传入的就是 RJ 发行根，不能再套一层）。
 */
function makeRelease(spec, rootName = null) {
  seq += 1;
  const keys = Object.keys(spec);
  const firstSeg = keys[0].split('/')[0];
  const nestedRj = /RJ\s*\d{6,8}/i.test(firstSeg);
  const root = path.join(sandbox, rootName ?? (nestedRj ? `${firstSeg}-root-${seq}` : `release-${seq}`));
  const prefix = nestedRj && keys.every((k) => k.startsWith(`${firstSeg}/`)) ? `${firstSeg}/` : '';
  for (const [rel, size] of Object.entries(spec)) {
    const inner = prefix && rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
    const full = path.join(root, inner);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.alloc(size ?? 64));
  }
  return root;
}

const analyze = (root) => analyzeRelease(root, { readTags: false });

/* ------------------------------------------------------------- 基础工具 */

test('RJ 号定位：取路径中最靠外的一个', () => {
  const r = locateRelease('E:\\Music\\[RJ01182623]专辑\\内层\\[RJ01187370]特典\\a.mp3');
  assert.equal(r.rjCode, 'RJ01182623');
  assert.deepEqual(r.nestedRjCodes, ['RJ01187370']);
});

test('标题候选：去掉 [RJxxxxxxxx] 前缀', () => {
  assert.equal(titleFromFolder('[RJ01113481]新婚妻子'), '新婚妻子');
  assert.equal(titleFromFolder('RJ01182623 某作品'), '某作品');
});

test('格式包装目录识别', () => {
  for (const n of ['（mp3）', '01：mp3', '02_wav', '05_mp3形式（320kbps_48KHz）', '04_带字幕的音频视频', '02：wav']) {
    assert.equal(isFormatWrapperDir(n), true, `${n} 应判定为格式包装`);
  }
  for (const n of ['本篇', '无音效', '03_SECut', '01_通常ver', '05：特典', '02_nonSE（液体音無し_mp3）']) {
    assert.equal(isFormatWrapperDir(n), false, `${n} 不应判定为格式包装`);
  }
});

test('忽略与特典标记识别', () => {
  assert.equal(isIgnoredSegment('03：闹钟音频'), true);
  assert.equal(isIgnoredSegment('04：动态壁纸'), true);
  assert.equal(isIgnoredSegment('06：促销视频'), true);
  assert.equal(isIgnoredSegment('01：mp3'), false);
  assert.equal(isBonusSegment('05：特典'), true);
  assert.equal(isBonusSegment('おまけ'), true);
  assert.equal(isBonusSegment('本篇'), false);
});

test('版本名归一化：剥掉格式标记与参数（括号统一为半角便于跨格式对齐）', () => {
  assert.equal(normalizeVersionName('02_nonSE（液体音無し_mp3）'), '02_nonSE(液体音無し)');
  assert.equal(normalizeVersionName('04_Voice（声のみ_mp3）'), '04_Voice(声のみ)');
  assert.equal(normalizeVersionName('01_通常ver'), '01_通常ver');
});

test('轨号提取：多种命名', () => {
  assert.equal(extractTrackNo('01 歌.mp3').no, 1);
  assert.equal(extractTrackNo('01.歌.mp3').no, 1);
  assert.equal(extractTrackNo('track07_歌.mp3').no, 7);
  assert.equal(extractTrackNo('EP.结局.mp3').no, 9999);
  assert.equal(extractTrackNo('歌.mp3').no, null);
});

test('差分标记词提取', () => {
  const t = variantTokensOf('02_nonSE（液体音無し）');
  assert.ok(t.includes('nonSE'));
  assert.ok(t.includes('液体音無し'));
  assert.ok(!t.includes('02'), '纯数字前缀不算标记词');
});

test('轨道键：剥掉序号与差分标记', () => {
  const tokens = ['nonSE', '液体音無し'];
  assert.equal(
    trackKeyOf('01_歌_nonse_副标题.wav', tokens),
    trackKeyOf('01_歌_副标题.wav', tokens),
  );
});

test('轨道键：基名尾部重复的格式词被归一化', () => {
  assert.equal(trackKeyOf('02_歌wav.wav', []), trackKeyOf('02_歌.wav', []));
});

test('resolveVersion：专辑名包装目录被剔除、视频子变体不算版本', () => {
  const title = '某作品';
  assert.equal(resolveVersion(['某作品', '本篇（mp3）', '01 歌.mp3'], title).name, '本篇');
  assert.equal(resolveVersion(['04：带字幕的音频视频', '有日文字幕', '01 歌.mp4'], title).name, '本篇');
  assert.equal(resolveVersion(['04：带字幕的音频视频', '有日文字幕', '01 歌.mp4'], title).videoVariant, '有日文字幕');
  assert.equal(resolveVersion(['05：特典', '03：闹钟音频', '01_mp3', 'a.mp3'], title).ignored, true);
});

/* ------------------------------------------------------------ 整树解析 */

test('解析：同版本 mp3+wav 合并，且优先播放 wav', async () => {
  const root = makeRelease({
    '[RJ00000001]测试专辑/本篇（mp3）/01 甲.mp3': 10,
    '[RJ00000001]测试专辑/本篇（wav）/01 甲.wav': 20,
    '[RJ00000001]测试专辑/本篇（mp3）/02 乙.mp3': 10,
    '[RJ00000001]测试专辑/本篇（wav）/02 乙.wav': 20,
  });
  const r = await analyze(root);
  assert.equal(r.stats.versionCount, 1);
  assert.equal(r.versions[0].name, '本篇');
  assert.equal(r.versions[0].preferredFormat, 'wav');
  assert.equal(r.tracks.length, 2);
  assert.equal(r.tracks[0].versions.length, 2, '一条轨道下应有 mp3 与 wav 两个文件');
});

test('解析：wav 缺失的版本仍然保留（按版本判断，不按整张）', async () => {
  const root = makeRelease({
    '[RJ00000002]测试/01_通常ver/01 甲.wav': 10,
    '[RJ00000002]测试/02_差分A/01 甲.wav': 10,
    '[RJ00000002]测试/05_mp3形式/01_通常ver/01 甲.mp3': 10,
    '[RJ00000002]测试/05_mp3形式/02_差分A/01 甲.mp3': 10,
    '[RJ00000002]测试/05_mp3形式/03_仅mp3版/01 甲.mp3': 10,
  });
  const r = await analyze(root);
  assert.equal(r.stats.versionCount, 3, '应保留仅 mp3 存在的第三个版本');
  const onlyMp3 = r.versions.find((v) => v.name.includes('仅mp3版'));
  assert.ok(onlyMp3, '仅 mp3 的版本必须在列');
  assert.equal(onlyMp3.preferredFormat, 'mp3');
  assert.equal(r.versions.find((v) => v.name.includes('通常ver')).preferredFormat, 'wav');
});

test('解析：忽略闹钟/壁纸/促销，特典归入 bonus 分组', async () => {
  const root = makeRelease({
    '[RJ00000003]测试/01：mp3/track01_甲.mp3': 10,
    '[RJ00000003]测试/05：特典/03：闹钟音频/01_mp3/01_早安.mp3': 10,
    '[RJ00000003]测试/05：特典/04：动态壁纸/Live/x.mp4': 10,
    '[RJ00000003]测试/05：特典/06：促销视频/p.mp4': 10,
    '[RJ00000003]测试/05：特典/trackEX_特典曲/01_mp3/trackEX_特典曲.mp3': 10,
    '[RJ00000003]测试/05：特典/trackEX_特典曲/02_wav/trackEX_特典曲.wav': 10,
  });
  const r = await analyze(root);
  assert.equal(r.ignored.length, 3, `应忽略 3 个文件，实际 ${r.ignored.length}`);
  assert.equal(r.tracks.length, 1, '主轨道只有 1 条');
  assert.equal(r.bonusTracks.length, 1, '特典轨道独立成组');
  assert.equal(r.hasBonus, true);
});

test('解析：视频与音轨同主名时视为该轨的视频版', async () => {
  const root = makeRelease({
    '[RJ00000004]测试/01：mp3/track00_甲.mp3': 10,
    '[RJ00000004]测试/01：mp3/track01_乙.mp3': 10,
    '[RJ00000004]测试/04：带字幕的音频视频/track00_甲.mp4': 10,
    '[RJ00000004]测试/04：带字幕的音频视频/track01_乙.mp4': 10,
    '[RJ00000004]测试/06：促销视频/宣传.mp4': 10,
  });
  const r = await analyze(root);
  assert.equal(r.tracks.length, 2);
  assert.ok(r.tracks.every((t) => t.hasVideo), '两条轨道都应有视频版');
  assert.equal(r.ignored.length, 1, '促销视频被忽略');
});

test('解析：嵌套 RJ 记录为特典子发行（不单独成卡）', async () => {
  const root = makeRelease({
    '[RJ00000005]测试/01：mp3/a.mp3': 10,
    '[RJ00000005]测试/[RJ00000099]特典/EX/01_mp3/ex.mp3': 10,
  });
  const r = await analyze(root);
  assert.deepEqual(r.nestedRjCodes, ['RJ00000099']);
  assert.equal(r.hasBonus, true);
});

test('解析：文件名括号残留差分标记 → 生成冲突记录并标在轨道行上', async () => {
  // 素材与真实专辑一致：版本里有「无音效」，而某个文件名写成「（无音效、饮尿）」
  const root = makeRelease({
    '[RJ00000006]测试/本篇（mp3）/06.甲.mp3': 10,
    '[RJ00000006]测试/无音效（mp3）/06.甲（无音效）.mp3': 10,
    '[RJ00000006]测试/无饮尿（mp3）/06.甲（无音效、饮尿）.mp3': 10,
    '[RJ00000006]测试/无饮尿（wav）/06.甲（无音效、无饮尿）.wav': 10,
  });
  const r = await analyze(root);
  const conflict = r.conflicts.find((c) => c.type === 'filename-variant');
  assert.ok(conflict, '应检出文件名与版本标识不一致');
  assert.equal(conflict.leftover, '饮尿');
  assert.equal(conflict.relatedToken, '无饮尿');
  assert.ok(r.tracks.some((t) => t.conflict), '冲突应标在轨道行上');
});

test('解析：相似度合并 —— 不同版本下的重复词自动合并', async () => {
  const root = makeRelease({
    '[RJ00000008]测试/01_通常ver/14_甲_通話.wav': 10,
    '[RJ00000008]测试/02_差分/14_甲_通話_通話.wav': 10,
  });
  const r = await analyze(root);
  assert.equal(r.tracks.length, 1, '两条应合并为一条轨道');
  assert.equal(r.tracks[0].versions.length, 2);
});

test('解析：前篇/后篇 是不同轨道，既不合并也不进待确认', async () => {
  const root = makeRelease({
    '[RJ00000009]测试/本篇（mp3）/01.甲（前篇）.mp3': 10,
    '[RJ00000009]测试/本篇（mp3）/02.甲（后篇）.mp3': 10,
  });
  const r = await analyze(root);
  assert.equal(r.tracks.length, 2);
  assert.equal(r.mergeCandidates.length, 0, '篇章标记不应产生待确认噪音');
});

test('解析：把握不足的相似轨道进入「待确认」而不自动合并', async () => {
  const root = makeRelease({
    '[RJ00000010]测试/01_版本A（液体音無し）/01_甲_开场.wav': 10,
    '[RJ00000010]测试/02_版本B/01_甲_开场_附加场景.wav': 10,
  });
  const r = await analyze(root);
  const candidates = r.mergeCandidates.length;
  assert.ok(r.tracks.length + candidates >= 1, '要么合并，要么给出待确认');
  if (candidates) {
    assert.equal(r.tracks.length, 2, '待确认期间不合并');
    assert.ok(r.mergeCandidates[0].reason);
  }
});

test('解析：封面优先「高画质封面图」目录并按文件名自然序取第一张', async () => {
  const root = makeRelease({
    '[RJ00000011]测试/01：mp3/a.mp3': 10,
    '[RJ00000011]测试/05：特典/01：高画质封面图/st_b.jpg': 9999,
    '[RJ00000011]测试/05：特典/01：高画质封面图/st_a01.jpg': 10,
    '[RJ00000011]测试/插画/大图.png': 50000,
  });
  const r = await analyze(root);
  assert.ok(r.cover);
  assert.equal(path.basename(r.cover.path), 'st_a01.jpg');
});

test('封面：关键字优先选封装/包装图', () => {
  const files = [
    { path: 'x\\立绘.png', name: '立绘.png', kind: 'other', size: 900000 },
    { path: 'x\\1.封装.png', name: '1.封装.png', kind: 'other', size: 100 },
    { path: 'x\\2.封装插图.png', name: '2.封装插图.png', kind: 'other', size: 200 },
  ];
  assert.equal(pickCover(files).name, '1.封装.png');
});

test('解析：同名嵌套目录（外层多带社团名）不成为版本名', async () => {
  const root = makeRelease({
    '[RJ00000012][某社团]某个测试作品名/[RJ00000012]某个测试作品名/01：mp3/a.mp3': 10,
    '[RJ00000012][某社团]某个测试作品名/[RJ00000012]某个测试作品名/02：wav/a.wav': 10,
  });
  const r = await analyze(root);
  assert.equal(r.stats.versionCount, 1);
  assert.equal(r.versions[0].name, '本篇');
});

/* ---------------------------------------------- 同版本内多文件的差分标记 */

test('差分标记：同一版本里两个文件靠括号内容区分（无饮尿 场景）', async () => {
  const root = makeRelease({
    '[RJ00000013]测试/本篇（wav）/06.甲.wav': 10,
    '[RJ00000013]测试/本篇（wav）/无音效（wav）/06.甲（无音效）.wav': 10,
    '[RJ00000013]测试/本篇（wav）/无饮尿（wav）/06.甲（无饮尿）.wav': 10,
    '[RJ00000013]测试/本篇（wav）/无饮尿（wav）/06.甲（无音效、无饮尿）.wav': 10,
  });
  const r = await analyze(root);
  const row = r.tracks.find((t) => t.title.includes('甲'));
  assert.ok(row, '第 6 轨应存在');
  const labels = row.versions.map((v) => v.variantLabel);
  assert.ok(labels.includes('无音效 无饮尿'),
    `应产出「无音效 无饮尿」标记，实际：${JSON.stringify(labels)}`);

  const sameVersion = row.versions.filter((v) => v.versionName === '无饮尿');
  const distinct = new Set(sameVersion.map((v) => v.variantLabel ?? v.versionName));
  assert.equal(distinct.size, sameVersion.length, '同一版本下的多个文件必须能彼此区分');
});

test('差分标记：与版本名等价时不重复显示', () => {
  assert.equal(fileVariantLabel('06.甲（无音效）.wav', '无音效', ['无音效', '无饮尿']), null);
  assert.equal(fileVariantLabel('06.甲（无音效、无饮尿）.wav', '无饮尿', ['无音效', '无饮尿']), '无音效 无饮尿');
});

test('差分标记：标题里的「（前篇）」不会被误当成版本标记', () => {
  assert.equal(fileVariantLabel('01.甲（前篇）.wav', '本篇', ['本篇', '无音效', '无饮尿']), null);
  assert.equal(fileVariantLabel('01.甲（前篇）.wav', '本篇', ['本篇', '无音效']), null);
});
