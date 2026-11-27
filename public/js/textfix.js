// 文字認識の結果を整える（DOM に依存しないので Node のテストからも使える）
//
// 1) 見た目がそっくりなカタカナ・漢字・ひらがなを、前後の文字から判断して直す
//    例: 入カ → 入力、工ラー → エラー、メ一ル → メール、人ロ → 人口
// 2) 認識の候補の中から、よく使う言葉・前に直した言葉に合うものを選ぶ

const isKanji = (c) => /[㐀-䶿一-鿿々]/.test(c);
const isKatakana = (c) => /[ァ-ヺー-ヿｦ-ﾟ]/.test(c);
const isHiragana = (c) => /[ぁ-ゖ]/.test(c);

// [カタカナ, 漢字]
const KANA_KANJI = [
  ['カ', '力'],
  ['ロ', '口'],
  ['エ', '工'],
  ['ニ', '二'],
  ['タ', '夕'],
  ['ト', '卜'],
  ['ハ', '八'],
  ['ー', '一'],
  ['オ', '才'],
  ['チ', '千'],
  ['セ', '世'],
  ['ヒ', '匕'],
  ['ム', '厶'],
];
const toKanji = new Map(KANA_KANJI);
const toKana = new Map(KANA_KANJI.map(([k, j]) => [j, k]));
// [ひらがな, カタカナ]
const HIRA_KATA = [
  ['へ', 'ヘ'],
  ['べ', 'ベ'],
  ['ぺ', 'ペ'],
  ['り', 'リ'],
];
const toKata = new Map(HIRA_KATA);
const toHira = new Map(HIRA_KATA.map(([h, k]) => [k, h]));

/** 前後の文字の種類（見分けにくい文字は飛ばして判断する） */
function neighborKinds(chars, i) {
  const kinds = [];
  for (const dir of [-1, 1]) {
    for (let j = i + dir; j >= 0 && j < chars.length; j += dir) {
      const c = chars[j];
      if (toKanji.has(c) || toKana.has(c) || toKata.has(c) || toHira.has(c)) continue;
      if (isKanji(c)) kinds.push('kanji');
      else if (isKatakana(c)) kinds.push('kata');
      else if (isHiragana(c)) kinds.push('hira');
      break;
    }
  }
  return kinds;
}

export function fixLookalikes(text) {
  if (!text) return text;
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const kinds = neighborKinds(chars, i);
    if (!kinds.length) continue;
    const has = (k) => kinds.includes(k);
    if (toKanji.has(c) && has('kanji') && !has('kata')) {
      // 「ー」は、前がカタカナでなければ長音にならないので「一」にする（例: 第ー → 第一）
      chars[i] = toKanji.get(c);
    } else if (toKana.has(c) && has('kata') && !has('kanji')) {
      chars[i] = toKana.get(c);
    } else if (toKata.has(c) && has('kata') && !has('hira')) {
      chars[i] = toKata.get(c);
    } else if (toHira.has(c) && has('hira') && !has('kata')) {
      chars[i] = toHira.get(c);
    }
  }
  return chars.join('');
}

/**
 * 候補から1つ選ぶ。
 * @param cands        認識の候補（よさそうな順）
 * @param vocab        よく使う言葉の集合（ボード内の文字や、前に直した結果）
 * @param corrections  前に直した内容 { 認識結果: 直した文字 }
 * @returns { text, candidates }  candidates は選んだものを先頭にした、重複のない一覧
 */
export function chooseCandidate(cands, { vocab = new Set(), corrections = {} } = {}) {
  const list = [];
  for (const c of cands || []) {
    if (!c) continue;
    for (const v of [fixLookalikes(c), c]) if (!list.includes(v)) list.push(v);
  }
  if (!list.length) return { text: null, candidates: [] };
  // 前に同じ読み間違いを直していれば、それを使う
  for (const c of list.slice(0, 3)) {
    const fixed = corrections[c];
    if (fixed) return { text: fixed, candidates: [fixed, ...list.filter((x) => x !== fixed)] };
  }
  // よく使う言葉と一致する候補を優先する（上位の候補ほど優先）
  let best = 0;
  let bestScore = -Infinity;
  list.forEach((c, rank) => {
    let score = -rank * 0.6;
    if (vocab.has(c)) score += 5;
    else {
      for (const w of vocab) {
        if (w.length >= 2 && c.length > w.length && c.includes(w)) {
          score += 1.5;
          break;
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = rank;
    }
  });
  const text = list[best];
  return { text, candidates: [text, ...list.filter((x) => x !== text)] };
}

/** 文字列から「よく使う言葉」に入れる単語を取り出す（行ごと・文全体） */
export function wordsOf(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (t.length >= 2 && t.length <= 40) out.push(t);
  }
  return out;
}
