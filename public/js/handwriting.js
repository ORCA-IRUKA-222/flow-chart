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
  return preds?.[0]?.text?.trim() || null;
}

/** 1行分の線を Google 形式の ink に変換（左上を原点、表示倍率をかけて画面相当の大きさに） */
export function toInk(line, k = 1) {
  const box = bboxOf(line.flat());
  const t0 = Math.min(...line.map((s) => s[0].t || 0));
  return {
    w: Math.ceil(box.w * k) + 20,
    h: Math.ceil(box.h * k) + 20,
    ink: line.map((pts) => [
      pts.map((p) => Math.round((p.x - box.x) * k + 10)),
      pts.map((p) => Math.round((p.y - box.y) * k + 10)),
      pts.map((p) => Math.round((p.t || 0) - t0)),
    ]),
  };
}

/**
 * 複数の行をまとめて認識する。
 * @param lines  [[stroke points...], ...]
 * @returns 各行の文字列（認識できなければ null）
 */
export async function recognizeLines(lines, { lang = 'ja', k = 1, token = '' } = {}) {
  const results = new Array(lines.length).fill(null);
  const rec = await nativeRecognizer(lang);
  if (rec) {
    await Promise.all(
      lines.map(async (line, i) => {
        try {
          results[i] = await recognizeNative(rec, line);
        } catch {
          results[i] = null;
        }
      }),
    );
  }
  const rest = results.map((r, i) => (r ? -1 : i)).filter((i) => i >= 0);
  if (!rest.length) return { results, ok: true };
  try {
    const res = await fetch('/api/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'x-flow-token': token } : {}) },
      body: JSON.stringify({ lang, items: rest.map((i) => toInk(lines[i], k)) }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const json = await res.json();
    rest.forEach((i, j) => (results[i] = json.results?.[j] || null));
    return { results, ok: true };
  } catch {
    return { results, ok: Boolean(rec) };
  }
}
