/**
 * 疑似乱码检测与修复。
 *
 * 典型来源：UTF-8 字节被当成 GBK / Shift-JIS / Latin-1 解码。
 * 这里不猜「原文是什么语言」，而是把字符串按候选编码重新编码成字节，
 * 再按 UTF-8 解码；只有**字节完整往返**且可读性明显变好时才返回建议。
 *
 * 只返回建议，不写任何文件；是否采用由编辑抽屉决定。
 */
import iconv from 'iconv-lite';

/* 常用字集合：用于给「修复前 / 修复后」打分。不是完整字典，只求把常见乱码和正常文本分开。 */
const COMMON_CJK = new Set([...(
  '的一是不了在人有我他这中大来上国个到说们为子和你地出道也时年得就那要下以生会自着去之过家学对可她里后小么心多天而能好都然没日于起还发成事只作当想看文无开手十用主行方又如前所本见经头面公同三已老从动两长知民样现分将外但身些与高意进把法此实回二理美点月明其种声全工己话儿者向情部正名定女问力机给等几很业最间新什打便位因重被走电四第门相次东政海口使教西再平真听世气信北少关并内加化由却代军产入先山五太水万市眼体别处总才场师书比住员九笑性通目华报立马命张活难神数件安表原车白应路期叫死常提感金何更反合放做系计或司利受光王果亲界及今京务制解各任至清物台象记边共风战干接它许八特觉望直服毛林题建南度统色字请交爱让认算论百吃义科怎元社术结六功指思非流每青管夫连远资队跟带花快条院变联言权往展该领传近留红治决周保达办运武半候七必城父强步完革深区即求品士转量空甚众技轻程告江语英基派满式李息写呢识极令黄德收脸钱党倒未持取设始版双历越史商千片容研像找友孩站广改议形委早房音火际则首单据导影失拿网香似斯专石若兵弟谁校读志飞观争究包组造落视济喜离虽坐集编宝谈府拉黑且随格尽剑讲布杀微怕母调局根曾准团段终乐切级克精哪官示冷域吗维措吸针脚毛'
  + '日本年大十二本中長出三時行見月後前生五間上東四今金九入学高円子外八六下来気小七山話女北午百書先名川千男語'
)]);
const KANA = new Set([...(
  'ぁあぃいぅうぇえぉおかがきぎくぐけげこごさざしじすずせぜそぞただちぢっつづてでとどなにぬねのはばぱひびぴふぶぷへべぺほぼぽまみむめもゃやゅゆょよらりるれろゎわゐゑをん'
  + 'ァアィイゥウェエォオカガキギクグケゲコゴサザシジスズセゼソゾタダチヂッツヅテデトドナニヌネノハバパヒビピフブプヘベペホボポマミムメモャヤュユョヨラリルレロヮワヰヱヲンヴヵヶ々ー'
)]);
const LATIN1_MOJIBAKE = new Set([...'ÃÂãåæçèéðÑÒÓõøùúûüýþâäàáíìîïñóôö÷']);
/* 常见乱码字：只用于「疑似」信号，不单独决定修复。 */
const KNOWN_MOJIBAKE = new Set([...'浣犲銇銈銉锛鐨涓鏄濂鍜銆浠涔鍙纭瀹鏂鏈鐢鍥绋璁鏃婊钀縺繧繝譌譛隱雿惩末']);
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const HIRAGANA_RE = /[\u3040-\u309F]/;
const KATAKANA_RE = /[\u30A0-\u30FF]/;
const LATIN_RE = /[A-Za-z]/;
const DIGIT_RE = /[0-9]/;
const PUNCT_RE = /[，。！？、；：（）「」『』【】《》…—～·,.!?;:()\[\]{}'"“”‘’\-+/&%]/;
const LEGACY_ENCODINGS = ['gbk', 'gb18030', 'cp932', 'shift_jis', 'big5', 'euc-kr'];

function stats(text) {
  let common = 0; let kana = 0; let hira = 0; let kata = 0;
  let cjk = 0; let latin = 0; let digit = 0; let punct = 0;
  let replacement = 0; let control = 0; let latinMojibake = 0; let known = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (ch === '\uFFFD') { replacement += 1; continue; }
    if (cp < 0x20 || (cp >= 0x7F && cp <= 0x9F)) { control += 1; continue; }
    if (KANA.has(ch)) {
      kana += 1;
      if (HIRAGANA_RE.test(ch)) hira += 1;
      else if (KATAKANA_RE.test(ch)) kata += 1;
    }
    if (CJK_RE.test(ch)) cjk += 1;
    if (COMMON_CJK.has(ch)) common += 1;
    if (LATIN_RE.test(ch)) latin += 1;
    if (DIGIT_RE.test(ch)) digit += 1;
    if (PUNCT_RE.test(ch)) punct += 1;
    if (LATIN1_MOJIBAKE.has(ch)) latinMojibake += 1;
    if (KNOWN_MOJIBAKE.has(ch)) known += 1;
  }
  return { common, kana, hira, kata, cjk, latin, digit, punct, replacement, control, latinMojibake, known };
}

function scoreText(text) {
  const s = stats(text);
  return s.common * 2.5
    + s.kana * 3
    + s.cjk * 0.4
    + s.latin * 0.2
    + s.digit * 0.15
    + s.punct * 0.05
    - s.replacement * 20
    - s.control * 10
    - s.latinMojibake * 2
    - s.known * 2
    - Math.max(0, s.cjk - s.common - s.known) * 0.25;
}

function hasSignal(text, s) {
  if (s.replacement || s.control) return true;
  if (s.latinMojibake >= 2 || /[ÃÂ]/.test(text)) return true;
  if (s.known >= 1) return true;
  // 中文里夹着孤立的片假名（例如「浣犲ソ」），也是典型 GBK 误解码
  if (s.kana > 0 && s.hira === 0 && s.cjk >= 2) return true;
  return false;
}

/**
 * @param {string} text
 * @returns {{original:string, fixed:string, encoding:string, confidence:number}|null}
 */
export function repairMojibake(text) {
  const original = String(text ?? '');
  if (!original.trim()) return null;
  if (original.length > 500) return null; // 标签值不应该这么长，避免误判大段文本

  const originalStats = stats(original);
  const originalScore = scoreText(original);
  const originalSignal = hasSignal(original, originalStats);
  const candidates = new Map();

  const add = (fixed, encoding) => {
    if (!fixed || fixed === original) return;
    if (fixed.includes('\uFFFD')) return;
    const st = stats(fixed);
    if (st.replacement || st.control) return;
    const score = scoreText(fixed);
    const previous = candidates.get(fixed);
    if (!previous || score > previous.score) {
      candidates.set(fixed, { fixed, encoding, score, stats: st });
    }
  };

  // UTF-8 字节被当成某种旧编码 → 按旧编码重新编码，再按 UTF-8 解码
  for (const enc of LEGACY_ENCODINGS) {
    try {
      const bytes = iconv.encode(original, enc);
      if (!bytes.length) continue;
      // 原文必须能被这种编码完整表示，否则是「编码器拿 ? 填充」的假候选
      if (iconv.decode(bytes, enc) !== original) continue;
      const fixed = iconv.decode(bytes, 'utf8');
      if (fixed.includes('\uFFFD')) continue;
      // bytes 是「原文按旧编码编码」的结果；修复文本的 UTF-8 字节必须与它一致
      if (!Buffer.from(fixed, 'utf8').equals(bytes)) continue;
      add(fixed, `utf8-from-${enc}`);
    } catch { /* 该编码不支持就跳过 */ }
  }

  // 旧编码字节被当成 Latin-1 / C1 控制字符 → 还原字节后按旧编码解码
  if ([...original].every((ch) => ch.codePointAt(0) <= 0xFF)) {
    const bytes = Buffer.from(original, 'latin1');
    const utf8 = bytes.toString('utf8');
    if (!utf8.includes('\uFFFD') && Buffer.from(utf8, 'utf8').toString('latin1') === original) {
      add(utf8, 'utf8-from-latin1');
    }
    for (const enc of LEGACY_ENCODINGS) {
      try {
        const fixed = iconv.decode(bytes, enc);
        if (fixed.includes('\uFFFD')) continue;
        if (!iconv.encode(fixed, enc).equals(bytes)) continue;
        add(fixed, `${enc}-from-latin1`);
      } catch { /* 忽略 */ }
    }
  }

  let best = null;
  for (const candidate of candidates.values()) {
    const delta = candidate.score - originalScore;
    const per = delta / Math.max(1, [...original].length);
    const kanaGain = candidate.stats.kana > originalStats.kana + 1;
    const weirdKanaMix = originalStats.kana > 0
      && originalStats.hira === 0
      && originalStats.cjk >= 2
      && candidate.stats.kana === 0;
    // 修复结果至少要有两个「常用汉字 / 假名」，否则很容易把乱码修成另一种乱码
    const plausible = candidate.stats.common + candidate.stats.kana >= 2;
    const accepted = plausible && ((originalSignal && delta >= 2 && per >= 0.15)
      || (kanaGain && delta >= 3 && per >= 0.2)
      || (weirdKanaMix && delta >= 4 && per >= 0.25)
      || (delta >= 6 && per >= 0.4));
    if (!accepted) continue;
    const confidence = Math.max(0, Math.min(0.99,
      0.55 + per * 0.45 + (originalSignal ? 0.1 : 0) + (kanaGain ? 0.05 : 0)));
    if (!best
      || candidate.score > best.score
      || (candidate.score === best.score && confidence > best.confidence)) {
      best = { ...candidate, delta, confidence };
    }
  }

  if (!best || best.confidence < 0.6) return null;
  return {
    original,
    fixed: best.fixed,
    encoding: best.encoding,
    confidence: Number(best.confidence.toFixed(2)),
  };
}
