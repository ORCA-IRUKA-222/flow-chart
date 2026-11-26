// 開いているボードの状態と、変更（トランザクション）・元に戻す/やり直しを管理する。
import { applyOp, emptyBoard, live } from '../shared/ops.js';

/** 端末の時計がずれていても単調増加する論理時刻 */
class Clock {
  constructor() {
    this.last = 0;
  }
  next() {
    this.last = Math.max(Date.now(), this.last + 1);
    return this.last;
  }
  observe(u) {
    if (u > this.last) this.last = u;
  }
}

const META = new Set(['id', 'u', 'c', 'deleted']);
function strip(v) {
  const out = {};
  for (const k in v) if (!META.has(k)) out[k] = v[k];
  return out;
}

const HISTORY_LIMIT = 200;

export class Doc extends EventTarget {
  constructor(clientId) {
    super();
    this.clientId = clientId;
    this.clock = new Clock();
    this.board = emptyBoard('none', '');
    this.undoStack = [];
    this.redoStack = [];
  }

  load(board) {
    this.board = board;
    this.board.nodes ||= {};
    this.board.edges ||= {};
    for (const coll of [board.nodes, board.edges]) for (const id in coll) this.clock.observe(coll[id].u || 0);
    this.undoStack = [];
    this.redoStack = [];
    this.emit({ ops: [], local: false, reset: true });
  }

  emit(detail) {
    this.dispatchEvent(new CustomEvent('change', { detail }));
  }

  get id() {
    return this.board.id;
  }

  nodes() {
    return live(this.board.nodes);
  }

  edges() {
    return live(this.board.edges);
  }

  node(id) {
    const n = this.board.nodes[id];
    return n && !n.deleted ? n : null;
  }

  edge(id) {
    const e = this.board.edges[id];
    return e && !e.deleted ? e : null;
  }

  get(k, id) {
    return k === 'node' ? this.node(id) : this.edge(id);
  }

  maxZ() {
    let z = 0;
    for (const n of this.nodes()) if ((n.z || 0) > z) z = n.z;
    return z;
  }

  /** 変更をまとめて行う。tx.commit() で反映 */
  tx() {
    const changes = new Map();
    const doc = this;
    const api = {
      put(k, v) {
        const key = `${k}:${v.id}`;
        const prev = doc.get(k, v.id);
        const ch = changes.get(key) || { k, id: v.id, before: prev ? strip(prev) : null };
        ch.after = strip({ ...(ch.after || prev || {}), ...v });
        changes.set(key, ch);
        return api;
      },
      del(k, id) {
        const key = `${k}:${id}`;
        const prev = doc.get(k, id);
        if (!prev && !changes.has(key)) return api;
        const ch = changes.get(key) || { k, id, before: prev ? strip(prev) : null };
        ch.after = null;
        changes.set(key, ch);
        return api;
      },
      /** ノードと、そこにつながる線をまとめて消す */
      delNode(id) {
        api.del('node', id);
        for (const e of doc.edges()) if (e.from === id || e.to === id) api.del('edge', e.id);
        return api;
      },
      get size() {
        return changes.size;
      },
      commit(opts) {
        return doc.commitChanges([...changes.values()], opts);
      },
    };
    return api;
  }

  commitChanges(changes, { history = true } = {}) {
    const ops = [];
    for (const ch of changes) {
      if (!ch.before && !ch.after) continue;
      const u = this.clock.next();
      const op = ch.after
        ? { t: 'put', k: ch.k, id: ch.id, v: ch.after, u, c: this.clientId }
        : { t: 'del', k: ch.k, id: ch.id, u, c: this.clientId };
      if (applyOp(this.board, op)) ops.push(op);
    }
    if (!ops.length) return [];
    if (history) this.pushHistory(changes);
    this.board.updatedAt = Date.now();
    this.emit({ ops, local: true });
    return ops;
  }

  /** 履歴だけを積む（ドラッグ中は履歴なしで反映し、最後にまとめて積む） */
  pushHistory(changes) {
    const useful = changes.filter((c) => JSON.stringify(c.before) !== JSON.stringify(c.after));
    if (!useful.length) return;
    this.undoStack.push(useful);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.commitChanges(
      entry.map((c) => ({ k: c.k, id: c.id, before: c.after, after: c.before })).reverse(),
      { history: false },
    );
    this.redoStack.push(entry);
    return true;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.commitChanges(entry, { history: false });
    this.undoStack.push(entry);
    return true;
  }

  /**
   * サーバーのスナップショットを取り込む。
   * 端末にだけ残っていて、サーバーにも送信待ちにもない要素は消す（他の端末で消されたもの）。
   */
  mergeSnapshot(snapshot, keepKeys = new Set()) {
    if (snapshot.name) this.board.name = snapshot.name;
    const ops = [];
    for (const k of ['node', 'edge']) {
      const local = k === 'node' ? this.board.nodes : this.board.edges;
      const remote = (k === 'node' ? snapshot.nodes : snapshot.edges) || {};
      for (const id of Object.keys(local)) {
        if (!Object.prototype.hasOwnProperty.call(remote, id) && !keepKeys.has(`${k}:${id}`)) delete local[id];
      }
      for (const id in remote) {
        const e = remote[id];
        ops.push(e.deleted ? { t: 'del', k, id, u: e.u, c: e.c } : { t: 'put', k, id, v: e, u: e.u, c: e.c });
      }
    }
    this.applyRemote(ops);
    this.emit({ ops: [], local: false });
  }

  applyRemote(ops) {
    const applied = [];
    for (const op of ops) {
      this.clock.observe(op.u || 0);
      if (applyOp(this.board, op)) applied.push(op);
    }
    if (applied.length) this.emit({ ops: applied, local: false });
    return applied;
  }
}
