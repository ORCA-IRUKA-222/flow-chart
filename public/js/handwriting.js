// 手書き文字の認識（ブラウザ側）。
// 1) ブラウザ内蔵の手書き認識 API（Chrome の一部環境）が使えればそれを使う
// 2) 使えなければサーバー（/api/recognize）経由で認識する
import { bboxOf } from './geometry.js';

let nativePromise = null;

function nativeRecognizer(lang) {
  if (!nativePromise) {
    nativePromise = (async () => {
      if (!('createHandwritingRecognizer' in navigator)) return null;
      try {
        if (navigator.queryHandwritingRecognizer) {
          const q = await navigator.queryHandwritingRecognizer({ languages: [lang] });
          if (!q) return null;
        }
        return await navigator.createHandwritingRecognizer({ languages: [lang] });
      } catch {
        return null;
      }
    })();
  }
  return nativePromise;
}

async function recognizeNative(rec, line) {
  const drawing = rec.startDrawing({ recognitionType: 'text', inputType: 'stylus' });
  for (const pts of line) {
    // eslint-disable-next-line no-undef
    const stroke = new HandwritingStroke();
    const t0 = pts[0].t || 0;
    for (const p of pts) stroke.addPoint({ x: p.x, y: p.y, t: (p.t || 0) - t0 });
    drawing.addStroke(stroke);
  }
  const preds = await drawing.getPrediction();
  drawing.clear?.();
  return (preds || []).map((p) => p.text?.trim()).filter(Boolean);
}

/**
 * 1行分の線を Google 形式の ink に変換する。
 * 小さく書いた字・大きく書いた字でも認識が安定するよう、行の高さが一般的な手書き入力欄と
 * 同じくらい（50〜160px）になるように拡大・縮小し、周りに余白を付ける。
 */
export function toInk(line, k = 1) {
  const box = bboxOf(line.flat());
  // 「一」のような平たい行でも極端に拡大しないよう、幅も目安に使う
  const ref = Math.max(box.h, box.w * 0.25, 1e-6);
  let scale = k;
  if (ref * scale < 50) scale = 50 / ref;
  if (ref * scale > 160) scale = 160 / ref;
  const pad = Math.round(Math.max(20, ref * scale * 0.3));
  const t0 = Math.min(...line.map((s) => s[0].t || 0));
  return {
    w: Math.ceil(box.w * scale) + pad * 2,
    h: Math.ceil(box.h * scale) + pad * 2,
    ink: line.map((pts) => [
      pts.map((p) => Math.round((p.x - box.x) * scale + pad)),
      pts.map((p) => Math.round((p.y - box.y) * scale + pad)),
      pts.map((p) => Math.round((p.t || 0) - t0)),
    ]),
  };
}

const GOOGLE_ENDPOINT = 'https://inputtools.google.com/request?ime=handwriting&app=flowchart&dbg=0&cs=1&oe=UTF-8';

/** 端末から直接 Google の手書き入力サービスに問い合わせる（同期サーバーがないとき） */
async function recognizeDirect(item, lang) {
  const res = await fetch(GOOGLE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
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
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(String(res.status));
  const json = await res.json();
  const cands = json?.[0] === 'SUCCESS' ? json[1]?.[0]?.[1] : null;
  return Array.isArray(cands) ? cands.filter((c) => typeof c === 'string' && c) : [];
}

/**
 * 複数の行をまとめて認識する。
 * 順番: ブラウザ内蔵の認識 → 同期サーバー経由 → 端末から直接
 * @param lines  [[stroke points...], ...]
 * @returns 各行の文字列（認識できなければ null）と、認識サービスに届いたか
 */
export async function recognizeLines(lines, { lang = 'ja', k = 1, token = '', server = null } = {}) {
  const results = new Array(lines.length).fill(null);
  // 各行の候補（1つ目が results と同じ）。間違えたときに選び直せるようにする
  const candidates = lines.map(() => []);
  const setCands = (i, list) => {
    candidates[i] = [...new Set(list.filter(Boolean))];
    results[i] = candidates[i][0] || null;
  };
  let reached = false;
  const rec = await nativeRecognizer(lang);
  if (rec) {
    reached = true;
    await Promise.all(
      lines.map(async (line, i) => {
        try {
          setCands(i, await recognizeNative(rec, line));
        } catch {
          results[i] = null;
        }
      }),
    );
  }
  const todo = () => results.map((r, i) => (r ? -1 : i)).filter((i) => i >= 0);
  let rest = todo();
  if (rest.length && server) {
    try {
      const res = await fetch(`${server}/api/recognize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'x-flow-token': token } : {}) },
        body: JSON.stringify({ lang, items: rest.map((i) => toInk(lines[i], k)) }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      rest.forEach((i, j) => setCands(i, json.candidates?.[j] || [json.results?.[j]]));
      reached = true;
    } catch {
      // サーバーに届かない → 端末から直接試す
    }
  }
  rest = reached ? [] : todo();
  if (rest.length) {
    const settled = await Promise.allSettled(rest.map((i) => recognizeDirect(toInk(lines[i], k), lang)));
    settled.forEach((r, j) => {
      if (r.status === 'fulfilled') {
        reached = true;
        setCands(rest[j], r.value);
      }
    });
  }
  return { results, candidates, ok: reached };
}
