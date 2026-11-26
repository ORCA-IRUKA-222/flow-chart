// 幾何計算のユーティリティ（DOM に依存しない）

export const GRID = 10;

export const snap = (v, g = GRID) => Math.round(v / g) * g;

export function center(n) {
  return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
}

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function bboxOf(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function unionBox(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function rectsIntersect(a, b) {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function containsPoint(r, p, margin = 0) {
  return p.x >= r.x - margin && p.x <= r.x + r.w + margin && p.y >= r.y - margin && p.y <= r.y + r.h + margin;
}

export function distToRect(p, r) {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

export function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distToPolyline(p, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, distToSegment(p, pts[i - 1], pts[i]));
  return pts.length === 1 ? dist(p, pts[0]) : best;
}

export function pathLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  return len;
}

/** 折れ線上の、全長に対する割合 t の位置 */
export function pointAlong(pts, t) {
  const total = pathLength(pts);
  let target = total * t;
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i]);
    if (target <= seg || i === pts.length - 1) {
      const r = seg ? Math.min(1, target / seg) : 0;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * r, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * r };
    }
    target -= seg;
  }
  return pts[0];
}

export function convexHull(points) {
  const pts = points.map((p) => ({ x: p.x, y: p.y })).sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

const PARA_SKEW = 0.18;

/** ノードの各辺の中点（接続点） */
export function sidePoint(n, side) {
  const skew = n.shape === 'parallelogram' ? Math.min(n.w * PARA_SKEW, 40) : 0;
  switch (side) {
    case 'top':
      return { x: n.x + n.w / 2, y: n.y };
    case 'bottom':
      return { x: n.x + n.w / 2, y: n.y + n.h };
    case 'left':
      return { x: n.x + skew / 2, y: n.y + n.h / 2 };
    case 'right':
    default:
      return { x: n.x + n.w - skew / 2, y: n.y + n.h / 2 };
  }
}

export function parallelogramSkew(n) {
  return Math.min(n.w * PARA_SKEW, 40);
}

/** 中心から (tx, ty) へ向かう直線と、ノードの輪郭との交点 */
export function boundaryPoint(n, target) {
  const c = center(n);
  const dx = target.x - c.x;
  const dy = target.y - c.y;
  if (!dx && !dy) return c;
  const hw = n.w / 2;
  const hh = n.h / 2;
  let t;
  if (n.shape === 'ellipse') {
    t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
  } else if (n.shape === 'diamond') {
    t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  } else {
    t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  }
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** 2つのノードを結ぶ線の経路（点列） */
export function routeEdge(a, b, style = 'orthogonal') {
  const ca = center(a);
  const cb = center(b);
  if (style === 'straight') return [boundaryPoint(a, cb), boundaryPoint(b, ca)];
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  const vGap = Math.abs(dy) - (a.h + b.h) / 2;
  const hGap = Math.abs(dx) - (a.w + b.w) / 2;
  if (vGap < 0 && hGap < 0) return [boundaryPoint(a, cb), boundaryPoint(b, ca)];
  if (vGap >= hGap) {
    const s = sidePoint(a, dy > 0 ? 'bottom' : 'top');
    const e = sidePoint(b, dy > 0 ? 'top' : 'bottom');
    if (Math.abs(s.x - e.x) < 1) return [s, { x: s.x, y: e.y }];
    const my = (s.y + e.y) / 2;
    return [s, { x: s.x, y: my }, { x: e.x, y: my }, e];
  }
  const s = sidePoint(a, dx > 0 ? 'right' : 'left');
  const e = sidePoint(b, dx > 0 ? 'left' : 'right');
  if (Math.abs(s.y - e.y) < 1) return [s, { x: e.x, y: s.y }];
  const mx = (s.x + e.x) / 2;
  return [s, { x: mx, y: s.y }, { x: mx, y: e.y }, e];
}

/** 角を丸めた SVG パス */
export function roundedPath(pts, r = 10) {
  if (pts.length < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const a = pts[i - 1];
    const b = pts[i + 1];
    const ra = Math.min(r, dist(a, p) / 2);
    const rb = Math.min(r, dist(p, b) / 2);
    const da = dist(a, p) || 1;
    const db = dist(p, b) || 1;
    const p1 = { x: p.x + ((a.x - p.x) / da) * ra, y: p.y + ((a.y - p.y) / da) * ra };
    const p2 = { x: p.x + ((b.x - p.x) / db) * rb, y: p.y + ((b.y - p.y) / db) * rb };
    d += ` L${p1.x.toFixed(1)} ${p1.y.toFixed(1)} Q${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
}

/** 線の終点に付ける矢印（三角形）の SVG パス */
export function arrowHead(pts, size = 11) {
  const tip = pts[pts.length - 1];
  let from = pts[pts.length - 2];
  for (let i = pts.length - 2; i >= 0 && dist(pts[i], tip) < 1; i--) from = pts[i - 1] || pts[i];
  const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
  const a1 = ang + Math.PI - 0.42;
  const a2 = ang + Math.PI + 0.42;
  return `M${tip.x.toFixed(1)} ${tip.y.toFixed(1)} L${(tip.x + Math.cos(a1) * size).toFixed(1)} ${(tip.y + Math.sin(a1) * size).toFixed(1)} L${(tip.x + Math.cos(a2) * size).toFixed(1)} ${(tip.y + Math.sin(a2) * size).toFixed(1)} Z`;
}
