// 手書き文字認識（サーバー側）。
// ブラウザから受け取った筆跡を Google の手書き入力サービスに送り、文字列を返す。
// HANDWRITING_ENDPOINT で別のサービスに差し替えられる（同じ形式の API に限る）。

const ENDPOINT =
  process.env.HANDWRITING_ENDPOINT || 'https://inputtools.google.com/request?ime=handwriting&app=flowchart&dbg=0&cs=1&oe=UTF-8';

const MAX_ITEMS = 200;
const MAX_STROKES = 400;
const MAX_POINTS = 2000;

function isNumArray(a, max) {
  return Array.isArray(a) && a.length <= max && a.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** 入力を検証して Google 形式の ink に揃える。不正なら null */
export function normalizeItems(items) {
  if (!Array.isArray(items) || items.length > MAX_ITEMS) return null;
  const out = [];
  for (const item of items) {
    if (!item || !Array.isArray(item.ink) || item.ink.length === 0 || item.ink.length > MAX_STROKES) return null;
    for (const stroke of item.ink) {
      if (!Array.isArray(stroke) || stroke.length < 2) return null;
      if (!isNumArray(stroke[0], MAX_POINTS) || !isNumArray(stroke[1], MAX_POINTS)) return null;
      if (stroke[2] && !isNumArray(stroke[2], MAX_POINTS)) return null;
    }
    out.push({
      w: Math.max(1, Math.round(Number(item.w) || 1)),
      h: Math.max(1, Math.round(Number(item.h) || 1)),
      ink: item.ink.map((s) => (s[2] ? [s[0], s[1], s[2]] : [s[0], s[1]])),
    });
  }
  return out;
}

/** 候補の一覧（よさそうな順）。なければ空 */
export function parseCandidates(json) {
  if (!Array.isArray(json) || json[0] !== 'SUCCESS') return [];
  const candidates = json[1]?.[0]?.[1];
  return Array.isArray(candidates) ? candidates.filter((c) => typeof c === 'string' && c) : [];
}

export function parseResponse(json) {
  return parseCandidates(json)[0] ?? null;
}

async function recognizeOne(item, lang) {
  const body = {
    options: 'enable_pre_space',
    requests: [
      {
        writing_guide: { writing_area_width: item.w, writing_area_height: item.h },
        ink: item.ink,
        language: lang,
        max_num_results: 6,
        max_completions: 0,
      },
    ],
  };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`handwriting service returned ${res.status}`);
  return parseCandidates(await res.json());
}

export async function recognizeHandwriting(items, lang = 'ja') {
  const safeLang = /^[a-zA-Z-]{2,10}$/.test(lang) ? lang : 'ja';
  const results = await Promise.allSettled(items.map((item) => recognizeOne(item, safeLang)));
  const errors = results.filter((r) => r.status === 'rejected');
  if (errors.length === results.length && results.length > 0) {
    throw errors[0].reason;
  }
  return results.map((r) => (r.status === 'fulfilled' ? r.value : []));
}
