// テスト用の「手書きっぽい」線を作る
let seed = 1;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647 - 0.5;
};

export function jitter(points, amount = 2) {
  return points.map((p, i) => ({ x: p.x + rand() * amount, y: p.y + rand() * amount, t: i * 8 }));
}

function segment(a, b, n = 20) {
  const out = [];
  for (let i = 0; i <= n; i++) out.push({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n });
  return out;
}

export function polyline(pts, n = 20) {
  const out = [];
  for (let i = 1; i < pts.length; i++) out.push(...segment(pts[i - 1], pts[i], n).slice(i > 1 ? 1 : 0));
  return out;
}

export function rectStroke(x, y, w, h) {
  return jitter(polyline([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x: x + 3, y: y + 4 }]));
}

export function rectFourStrokes(x, y, w, h) {
  const c = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  return [0, 1, 2, 3].map((i) => jitter(polyline([c[i], c[(i + 1) % 4]])));
}

export function diamondStroke(x, y, w, h) {
  return jitter(
    polyline([
      { x: x + w / 2, y },
      { x: x + w, y: y + h / 2 },
      { x: x + w / 2, y: y + h },
      { x, y: y + h / 2 },
      { x: x + w / 2 + 3, y: y + 3 },
    ]),
  );
}

export function ellipseStroke(x, y, w, h) {
  const pts = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * Math.PI * 2 * 1.02;
    pts.push({ x: x + w / 2 + Math.cos(a) * (w / 2), y: y + h / 2 + Math.sin(a) * (h / 2) });
  }
  return jitter(pts);
}

export function stadiumStroke(x, y, w, h) {
  const r = h / 2;
  const pts = [];
  for (let i = 0; i <= 16; i++) {
    const a = -Math.PI / 2 + (i / 16) * Math.PI;
    pts.push({ x: x + w - r + Math.cos(a) * r, y: y + r + Math.sin(a) * r });
  }
  for (let i = 0; i <= 16; i++) {
    const a = Math.PI / 2 + (i / 16) * Math.PI;
    pts.push({ x: x + r + Math.cos(a) * r, y: y + r + Math.sin(a) * r });
  }
  pts.push({ x: x + w - r, y });
  return jitter(polyline(pts, 2));
}

export function parallelogramStroke(x, y, w, h) {
  const s = w * 0.25;
  return jitter(polyline([{ x: x + s, y }, { x: x + w, y }, { x: x + w - s, y: y + h }, { x, y: y + h }, { x: x + s + 2, y: y + 2 }]));
}

export function lineStroke(a, b) {
  return jitter(polyline([a, b]), 1.5);
}

/** 小さな「文字っぽい」線（数本） */
export function scribble(x, y, size = 20) {
  return [
    jitter(polyline([{ x, y }, { x: x + size, y }], 6), 1),
    jitter(polyline([{ x: x + size / 2, y: y - size / 3 }, { x: x + size / 2, y: y + size }], 6), 1),
    jitter(polyline([{ x: x + 2, y: y + size * 0.6 }, { x: x + size - 2, y: y + size * 0.6 }], 6), 1),
  ];
}

export const S = (points) => ({ points, k: 1 });
