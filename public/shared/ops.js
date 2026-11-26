// ボードへの操作（op）の適用ロジック。サーバーとブラウザの両方で使う。
//
// ボードは nodes / edges の2つの集合を持ち、要素ごとに「後勝ち（LWW）」で更新する。
// 各要素は u（論理時刻）と c（クライアントID）を持ち、(u, c) が大きい方が勝つ。
// これにより、どの順番で op が届いても全端末が同じ状態に収束する。
//
// op の形:
//   { t: 'put', k: 'node' | 'edge', id, v: {...}, u, c }
//   { t: 'del', k: 'node' | 'edge', id, u, c }

export const SHAPES = ['rect', 'round', 'diamond', 'ellipse', 'parallelogram', 'text'];
export const COLORS = ['default', 'blue', 'green', 'yellow', 'red', 'purple', 'gray'];
export const EDGE_STYLES = ['orthogonal', 'straight'];

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id) && !id.startsWith('__');
}

export function emptyBoard(id, name = '無題のボード') {
  const now = Date.now();
  return { id, name, createdAt: now, updatedAt: now, nodes: {}, edges: {} };
}

/** a が b より新しければ正の数を返す */
export function compareStamp(a, b) {
  if (a.u !== b.u) return a.u - b.u;
  const ac = a.c || '';
  const bc = b.c || '';
  return ac < bc ? -1 : ac > bc ? 1 : 0;
}

function num(v, fallback, min = -1e9, max = 1e9) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** 外部から来た値を安全な形に整える */
export function sanitize(kind, v) {
  if (!v || typeof v !== 'object') return null;
  if (kind === 'node') {
    return {
      x: num(v.x, 0),
      y: num(v.y, 0),
      w: num(v.w, 140, 10, 5000),
      h: num(v.h, 60, 10, 5000),
      shape: SHAPES.includes(v.shape) ? v.shape : 'rect',
      color: COLORS.includes(v.color) ? v.color : 'default',
      text: str(v.text, 5000),
      z: num(v.z, 0),
    };
  }
  if (kind === 'edge') {
    if (!isValidId(v.from) || !isValidId(v.to)) return null;
    return {
      from: v.from,
      to: v.to,
      label: str(v.label, 500),
      style: EDGE_STYLES.includes(v.style) ? v.style : 'orthogonal',
      arrow: v.arrow !== false,
    };
  }
  return null;
}

/** op をボードに適用する。状態が変わったら true */
export function applyOp(board, op) {
  if (!op || typeof op !== 'object') return false;
  if (op.k !== 'node' && op.k !== 'edge') return false;
  if (!isValidId(op.id) || typeof op.u !== 'number' || !Number.isFinite(op.u)) return false;
  const coll = op.k === 'node' ? board.nodes : board.edges;
  const cur = Object.prototype.hasOwnProperty.call(coll, op.id) ? coll[op.id] : null;
  if (cur && compareStamp(op, cur) <= 0) return false;
  const c = typeof op.c === 'string' ? op.c.slice(0, 64) : '';
  if (op.t === 'put') {
    const v = sanitize(op.k, op.v);
    if (!v) return false;
    coll[op.id] = { ...v, id: op.id, u: op.u, c };
  } else if (op.t === 'del') {
    coll[op.id] = { id: op.id, deleted: true, u: op.u, c };
  } else {
    return false;
  }
  return true;
}

export function live(coll) {
  const out = [];
  for (const id in coll) {
    const e = coll[id];
    if (e && !e.deleted) out.push(e);
  }
  return out;
}

/** 古い削除記録（tombstone）を掃除する */
export function pruneTombstones(board, maxAgeMs = 1000 * 60 * 60 * 24 * 30, now = Date.now()) {
  for (const coll of [board.nodes, board.edges]) {
    for (const id of Object.keys(coll)) {
      const e = coll[id];
      if (e.deleted && now - e.u > maxAgeMs) delete coll[id];
    }
  }
}

export function boardSummary(board) {
  let nodeCount = 0;
  for (const id in board.nodes) if (!board.nodes[id].deleted) nodeCount++;
  return { id: board.id, name: board.name, updatedAt: board.updatedAt, createdAt: board.createdAt, nodeCount };
}

function pick(a, b) {
  if (!a) return b;
  if (!b) return a;
  return compareStamp(a, b) >= 0 ? a : b;
}

/**
 * 2つのボードを合わせる（要素ごとに新しい方を残す）。どちらの順で合わせても同じ結果になる。
 * ボード名は nameU（名前を変えた時刻）が新しい方を残す。
 */
export function mergeBoards(a, b) {
  if (!a) return b ? { ...b, nodes: { ...b.nodes }, edges: { ...b.edges } } : null;
  if (!b) return { ...a, nodes: { ...a.nodes }, edges: { ...a.edges } };
  const nameFromB = (b.nameU || 0) > (a.nameU || 0);
  const out = {
    id: a.id || b.id,
    name: nameFromB ? b.name : a.name,
    nameU: Math.max(a.nameU || 0, b.nameU || 0),
    createdAt: Math.min(a.createdAt || Infinity, b.createdAt || Infinity),
    updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
    nodes: {},
    edges: {},
  };
  if (!Number.isFinite(out.createdAt)) out.createdAt = Date.now();
  for (const k of ['nodes', 'edges']) {
    const A = a[k] || {};
    const B = b[k] || {};
    for (const id in A) out[k][id] = pick(A[id], Object.prototype.hasOwnProperty.call(B, id) ? B[id] : null);
    for (const id in B) if (!Object.prototype.hasOwnProperty.call(out[k], id)) out[k][id] = B[id];
  }
  return out;
}

/** local に、remote にない（または新しい）内容があれば true */
export function hasNewer(local, remote) {
  if (!remote) return true;
  if ((local.nameU || 0) > (remote.nameU || 0)) return true;
  for (const k of ['nodes', 'edges']) {
    const L = local[k] || {};
    const R = remote[k] || {};
    for (const id in L) {
      const r = Object.prototype.hasOwnProperty.call(R, id) ? R[id] : null;
      if (!r || compareStamp(L[id], r) > 0) return true;
    }
  }
  return false;
}
