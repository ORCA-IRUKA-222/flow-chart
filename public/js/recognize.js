// 手書きのインク（筆跡）を解析して、図形・矢印・文字のまとまりに分ける。
// DOM に依存しないので Node のテストからも使える。
//
// 入力の stroke は { points: [{x, y, t}], k } で、座標はワールド座標、
// k は書いたときの表示倍率。しきい値は「画面上のピクセル」で考えて k で割る。
import {
  GRID,
  bboxOf,
  center,
  containsPoint,
  convexHull,
  dist,
  distToPolyline,
  distToRect,
  pathLength,
  polygonArea,
  snap,
} from './geometry.js';

function strokeInfo(points, i) {
  const bbox = bboxOf(points);
  const diag = Math.hypot(bbox.w, bbox.h);
  const len = pathLength(points);
  const start = points[0];
  const end = points[points.length - 1];
  const gap = dist(start, end);
  return {
    i,
    points,
    bbox,
    diag,
    len,
    start,
    end,
    gap,
    minDim: Math.min(bbox.w, bbox.h),
    maxDim: Math.max(bbox.w, bbox.h),
    center: { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 },
  };
}

function isClosed(si, S) {
  return si.len > 1.6 * si.diag && si.gap <= Math.max(22 * S, 0.22 * si.maxDim);
}

/** 閉じた点群が、どの図形に近いかを判定する */
export function classifyShape(points) {
  const box = bboxOf(points);
  const hull = convexHull(points);
  const ratio = box.w * box.h > 0 ? polygonArea(hull) / (box.w * box.h) : 0;
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ];
  const cornerTol = 0.15 * Math.min(box.w, box.h);
  const near = corners.map((c) => hull.some((p) => dist(p, c) < cornerTol));
  const count = near.filter(Boolean).length;
  if (count >= 3) return 'rect';
  if (count === 2 && ((near[1] && near[3]) || (near[0] && near[2]))) {
    return ratio > 0.92 ? 'rect' : 'parallelogram';
  }
  if (ratio < 0.66) return 'diamond';
  if (ratio >= 0.86) return 'round';
  return 'ellipse';
}

class UnionFind {
  constructor(n) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(i) {
    while (this.p[i] !== i) i = this.p[i] = this.p[this.p[i]];
    return i;
  }
  union(a, b) {
    this.p[this.find(a)] = this.find(b);
  }
}

/** 複数の線で描いた閉じた図形（例: 4本の線で描いた四角）を探す */
function findMultiStrokeShapes(infos, S) {
  const cand = infos.filter((si) => si.maxDim >= 16 * S);
  if (cand.length < 2) return [];
  const tol = 20 * S;
  const uf = new UnionFind(cand.length);
  const ends = cand.map((si) => [si.start, si.end]);
  for (let a = 0; a < cand.length; a++) {
    for (let b = a + 1; b < cand.length; b++) {
      if (ends[a].some((p) => ends[b].some((q) => dist(p, q) <= tol))) uf.union(a, b);
    }
  }
  const groups = new Map();
  cand.forEach((_, i) => {
    const r = uf.find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });
  const shapes = [];
  for (const members of groups.values()) {
    if (members.length < 2 || members.length > 6) continue;
    // 全ての端点が、別の線の端点とつながっていれば「閉じている」
    const closed = members.every((a) =>
      ends[a].every((p) => members.some((b) => b !== a && ends[b].some((q) => dist(p, q) <= tol))),
    );
    if (!closed) continue;
    const points = members.flatMap((m) => cand[m].points);
    const bbox = bboxOf(points);
    if (Math.min(bbox.w, bbox.h) < 24 * S || Math.max(bbox.w, bbox.h) < 40 * S) continue;
    shapes.push({ idx: members.map((m) => cand[m].i), points, bbox });
  }
  return shapes;
}

function sameTarget(a, b) {
  return a && b && a.type === b.type && (a.type === 'node' ? a.id === b.id : a.index === b.index);
}

/**
 * インクを解析する。
 * @param strokes  [{ points, k }]
 * @param nodes    既存ノード（矢印の接続先や、文字の書き込み先になる）
 * @param edges    既存の線 [{ id, points }]（ラベルの書き込み先になる）
 */
export function analyzeInk(strokes, { nodes = [], edges = [] } = {}) {
  const ks = strokes.map((s) => s.k || 1).sort((a, b) => a - b);
  const S = 1 / (ks[Math.floor(ks.length / 2)] || 1);
  const infos = strokes
    .map((s, i) => (s.points.length > 0 ? { ...strokeInfo(s.points, i), kind: s.kind || null } : null))
    .filter(Boolean);
  // 文字ペンの線は文字だけ、図形ペンの線は図形・矢印だけとして扱う（ペンの種類がなければ形から推測）
  const maybeShape = (si) => si.kind !== 'text';
  const maybeText = (si) => si.kind !== 'shape';
  const used = new Set();

  // 1) 図形: 1本で閉じた線 + 複数の線で閉じた形
  let candidates = [];
  for (const si of infos) {
    if (maybeShape(si) && isClosed(si, S) && si.minDim >= 24 * S && si.maxDim >= 40 * S) {
      candidates.push({ idx: [si.i], points: si.points, bbox: si.bbox });
    }
  }
  const openInfos = infos.filter((si) => maybeShape(si) && !candidates.some((c) => c.idx.includes(si.i)));
  candidates.push(...findMultiStrokeShapes(openInfos, S));

  // 大きい順に並べ、他の図形や既存ノードの中にあるもの（"口" などの文字）は除く
  candidates.sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h);
  const shapes = [];
  for (const c of candidates) {
    const cc = { x: c.bbox.x + c.bbox.w / 2, y: c.bbox.y + c.bbox.h / 2 };
    // 図形ペンで描いたとはっきりしていれば、他の図形の中でも図形として扱う
    const surelyShape = c.idx.every((i) => infos.find((x) => x.i === i)?.kind === 'shape');
    if (!surelyShape && shapes.some((s) => containsPoint(s.bbox, cc))) continue;
    if (!surelyShape && nodes.some((n) => containsPoint(n, cc))) continue;
    shapes.push({ ...c, shape: classifyShape(c.points) });
    c.idx.forEach((i) => used.add(i));
  }

  const targets = [
    ...shapes.map((s, index) => ({ ref: { type: 'shape', index }, box: s.bbox })),
    ...nodes.map((n) => ({ ref: { type: 'node', id: n.id }, box: n })),
  ];
  const innermostTarget = (p, margin = 0) => {
    let best = null;
    for (const t of targets) {
      if (containsPoint(t.box, p, margin) && (!best || t.box.w * t.box.h < best.box.w * best.box.h)) best = t;
    }
    return best;
  };
  const nearestTarget = (p, tol) => {
    let best = null;
    let bestD = Infinity;
    for (const t of targets) {
      const d = distToRect(p, t.box);
      if (d <= tol && (d < bestD || (d === bestD && best && t.box.w * t.box.h < best.box.w * best.box.h))) {
        best = t;
        bestD = d;
      }
    }
    return best;
  };

  // 2) 矢印（線）: 両端がそれぞれ別の図形・ノードの近くにある線
  const connectors = [];
  for (const si of infos) {
    if (used.has(si.i) || !maybeShape(si) || si.len < 40 * S) continue;
    const inside = innermostTarget(si.center);
    if (inside && containsPoint(inside.box, si.start) && containsPoint(inside.box, si.end)) continue;
    const a = nearestTarget(si.start, 30 * S);
    const b = nearestTarget(si.end, 30 * S);
    if (!a || !b || sameTarget(a.ref, b.ref)) continue;
    connectors.push({ from: a.ref, to: b.ref, idx: [si.i], points: si.points, heads: { start: false, end: false } });
    used.add(si.i);
  }

  // 3) 矢じり: 線の端の近くにある小さな線
  for (const si of infos) {
    if (used.has(si.i) || !maybeShape(si) || si.maxDim > 45 * S) continue;
    if (innermostTarget(si.center)) continue;
    for (const c of connectors) {
      const s = c.points[0];
      const e = c.points[c.points.length - 1];
      const ds = distToRect(s, si.bbox);
      const de = distToRect(e, si.bbox);
      if (Math.min(ds, de) <= 18 * S) {
        if (de <= ds) c.heads.end = true;
        else c.heads.start = true;
        c.idx.push(si.i);
        used.add(si.i);
        break;
      }
    }
  }
  for (const c of connectors) {
    if (c.heads.start && !c.heads.end) [c.from, c.to] = [c.to, c.from];
  }

  // 4) 文字: 残りの線。図形・ノードの中なら、その中の文字として扱う
  const inTarget = new Map();
  const free = [];
  for (const si of infos) {
    if (used.has(si.i) || !maybeText(si)) continue;
    const t = innermostTarget(si.center, 2 * S);
    if (t) {
      const key = t.ref.type === 'node' ? `n:${t.ref.id}` : `s:${t.ref.index}`;
      if (!inTarget.has(key)) inTarget.set(key, { target: t.ref, strokes: [] });
      inTarget.get(key).strokes.push(si);
      used.add(si.i);
    } else if (si.maxDim <= (si.kind === 'text' ? 400 : 120) * S) {
      free.push(si);
    }
  }

  // 近くにある線どうしを1つの文字列としてまとめる
  const gapTol = 28 * S;
  const uf = new UnionFind(free.length);
  for (let a = 0; a < free.length; a++) {
    for (let b = a + 1; b < free.length; b++) {
      const A = free[a].bbox;
      const B = free[b].bbox;
      const gx = Math.max(0, Math.max(A.x, B.x) - Math.min(A.x + A.w, B.x + B.w));
      const gy = Math.max(0, Math.max(A.y, B.y) - Math.min(A.y + A.h, B.y + B.h));
      if (gx <= gapTol && gy <= gapTol * 0.7) uf.union(a, b);
    }
  }
  const clusters = new Map();
  free.forEach((si, i) => {
    const r = uf.find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(si);
  });

  const texts = [...inTarget.values()].map((g) => ({
    target: g.target,
    strokes: g.strokes.map((s) => s.points),
    idx: g.strokes.map((s) => s.i),
    bbox: bboxOf(g.strokes.flatMap((s) => s.points)),
  }));
  const lineTargets = [
    ...connectors.map((c, index) => ({ ref: { type: 'connector', index }, points: c.points })),
    ...edges.map((e) => ({ ref: { type: 'edge', id: e.id }, points: e.points })),
  ];
  for (const members of clusters.values()) {
    const box = bboxOf(members.flatMap((m) => m.points));
    const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    let target = { type: 'free' };
    let best = 55 * S;
    for (const lt of lineTargets) {
      const d = distToPolyline(c, lt.points);
      if (d < best) {
        best = d;
        target = lt.ref;
      }
    }
    members.forEach((m) => used.add(m.i));
    texts.push({ target, strokes: members.map((m) => m.points), idx: members.map((m) => m.i), bbox: box });
  }

  const leftover = infos.filter((si) => !used.has(si.i)).map((si) => si.i);
  return { shapes, connectors, texts, leftover, scale: S };
}

/** 文字の線を行ごとに分ける（縦方向の隙間で区切る） */
export function splitLines(strokes) {
  if (strokes.length <= 1) return [strokes];
  const items = strokes.map((pts) => ({ pts, box: bboxOf(pts) }));
  const heights = items.map((it) => it.box.h).sort((a, b) => a - b);
  const charH = Math.max(heights[Math.floor(heights.length * 0.9)] || 1, 1);
  items.sort((a, b) => a.box.y - b.box.y);
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (cur && it.box.y <= cur.bottom + charH * 0.5) {
      cur.items.push(it);
      cur.bottom = Math.max(cur.bottom, it.box.y + it.box.h);
    } else {
      cur = { items: [it], bottom: it.box.y + it.box.h };
      lines.push(cur);
    }
  }
  return lines.map((l) => l.items.sort((a, b) => a.box.x - b.box.x).map((it) => it.pts));
}

const MIN_SIZE = {
  rect: [100, 50],
  round: [110, 50],
  parallelogram: [130, 50],
  diamond: [130, 80],
  ellipse: [110, 60],
  text: [40, 30],
};

/** 図形の外接矩形から、きれいに整ったノードの位置・大きさを作る */
export function tidyBox(shape, box) {
  const [mw, mh] = MIN_SIZE[shape] || MIN_SIZE.rect;
  const w = Math.max(mw, snap(box.w, GRID * 2));
  const h = Math.max(mh, snap(box.h, GRID * 2));
  const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  return { x: snap(c.x - w / 2), y: snap(c.y - h / 2), w, h };
}

/**
 * 新しいノードを、他のノードと中心線がそろうように少しずらす。
 * 既存ノードは動かさない（基準になる）。
 */
export function alignNodes(newNodes, fixedNodes = [], tol = 24) {
  const out = newNodes.map((n) => ({ ...n }));
  for (const axis of ['x', 'y']) {
    const size = axis === 'x' ? 'w' : 'h';
    const anchors = fixedNodes.map((n) => n[axis] + n[size] / 2);
    // 既存ノードに近ければそちらへ合わせる
    for (const n of out) {
      const c = n[axis] + n[size] / 2;
      let best = null;
      for (const a of anchors) if (Math.abs(a - c) <= tol && (best === null || Math.abs(a - c) < Math.abs(best - c))) best = a;
      if (best !== null) {
        n[axis] = best - n[size] / 2;
        n._aligned = { ...(n._aligned || {}), [axis]: true };
      }
    }
    // 新しいノードどうしで、近いものの中心をそろえる
    const free = out.filter((n) => !n._aligned?.[axis]).sort((a, b) => a[axis] + a[size] / 2 - (b[axis] + b[size] / 2));
    let group = [];
    const flush = () => {
      if (group.length > 1) {
        const avg = snap(group.reduce((s, n) => s + n[axis] + n[size] / 2, 0) / group.length);
        for (const n of group) n[axis] = avg - n[size] / 2;
      }
      group = [];
    };
    for (const n of free) {
      const c = n[axis] + n[size] / 2;
      if (group.length && c - (group[0][axis] + group[0][size] / 2) > tol) flush();
      group.push(n);
    }
    flush();
  }
  for (const n of out) delete n._aligned;
  return out;
}

/** 同じ形で大きさが近いノードは、大きさをそろえる */
export function unifySizes(nodes, ratio = 0.3) {
  const out = nodes.map((n) => ({ ...n }));
  const byShape = new Map();
  for (const n of out) {
    if (!byShape.has(n.shape)) byShape.set(n.shape, []);
    byShape.get(n.shape).push(n);
  }
  for (const list of byShape.values()) {
    const done = new Set();
    for (const n of list) {
      if (done.has(n)) continue;
      const similar = list.filter(
        (m) => !done.has(m) && Math.abs(m.w - n.w) <= n.w * ratio && Math.abs(m.h - n.h) <= n.h * ratio,
      );
      const w = Math.max(...similar.map((m) => m.w));
      const h = Math.max(...similar.map((m) => m.h));
      for (const m of similar) {
        const c = center(m);
        m.w = w;
        m.h = h;
        m.x = c.x - w / 2;
        m.y = c.y - h / 2;
        done.add(m);
      }
    }
  }
  return out;
}
