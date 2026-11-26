// サーバーとの同期（WebSocket）。
// 送信待ちの変更は端末内に保存しておき、オフラインから戻ったときに自動で送る。
import { idbGet, idbSet } from './idb.js';
import { debounce, uid } from './util.js';

const FLUSH_MS = 40;

export class Sync extends EventTarget {
  constructor({ token = '' } = {}) {
    super();
    this.token = token;
    this.ws = null;
    this.status = 'offline';
    this.boardId = null;
    this.boardName = '';
    this.pending = []; // [{ bid, boardId, ops }]
    this.localCreated = {}; // オフライン中に作ったボード { id: name }
    this.outbox = new Map(); // boardId -> ops
    this.outboxTimer = null;
    this.retryMs = 1000;
    this.retryTimer = null;
    this.persist = debounce(() => this.save(), 300);
  }

  async init() {
    this.pending = (await idbGet('pending')) || [];
    this.localCreated = (await idbGet('localCreated')) || {};
  }

  async save() {
    await idbSet('pending', this.pending);
    await idbSet('localCreated', this.localCreated);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setStatus(s) {
    this.status = s;
    this.emit('status', s);
  }

  get online() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  connect() {
    clearTimeout(this.retryTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = this.token ? `?token=${encodeURIComponent(this.token)}` : '';
    this.setStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws${q}`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 1000;
      this.setStatus('online');
      for (const [id, name] of Object.entries(this.localCreated)) this.raw({ type: 'ensure', boardId: id, name });
      for (const batch of this.pending) this.raw({ type: 'ops', ...batch });
      if (this.boardId) this.raw({ type: 'join', boardId: this.boardId, name: this.boardName });
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setStatus('offline');
      this.scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  scheduleReconnect() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 1.7, 15000);
  }

  /** 画面に戻ったときなど、すぐに再接続を試す */
  reconnectNow() {
    if (!this.ws) {
      this.retryMs = 1000;
      this.connect();
    }
  }

  raw(msg) {
    if (this.online) this.ws.send(JSON.stringify(msg));
  }

  handle(msg) {
    switch (msg.type) {
      case 'boards': {
        let changed = false;
        for (const b of msg.boards || []) {
          if (this.localCreated[b.id]) {
            delete this.localCreated[b.id];
            changed = true;
          }
        }
        if (changed) this.persist();
        this.emit('boards', msg.boards || []);
        break;
      }
      case 'snapshot':
        if (msg.board?.id === this.boardId) this.emit('snapshot', msg.board);
        break;
      case 'ops':
        if (msg.boardId === this.boardId) this.emit('ops', msg.ops || []);
        break;
      case 'ack': {
        const before = this.pending.length;
        this.pending = this.pending.filter((b) => b.bid !== msg.bid);
        if (this.pending.length !== before) this.persist();
        this.emit('pending', this.pending.length);
        break;
      }
      case 'board-deleted':
        delete this.localCreated[msg.boardId];
        this.pending = this.pending.filter((b) => b.boardId !== msg.boardId);
        this.persist();
        this.emit('board-deleted', msg.boardId);
        break;
      default:
        break;
    }
  }

  join(boardId, name) {
    this.boardId = boardId;
    this.boardName = name;
    this.raw({ type: 'join', boardId, name });
  }

  /** 新しいボードをサーバーに作る（オフラインなら接続時に作る） */
  ensure(boardId, name) {
    this.localCreated[boardId] = name;
    this.persist();
    this.raw({ type: 'ensure', boardId, name });
  }

  rename(boardId, name) {
    if (this.localCreated[boardId]) {
      this.localCreated[boardId] = name;
      this.persist();
    }
    if (!this.online) return false;
    this.raw({ type: 'rename', boardId, name });
    return true;
  }

  remove(boardId) {
    if (!this.online) return false;
    this.raw({ type: 'delete', boardId });
    return true;
  }

  pendingCount(boardId) {
    return this.pending.filter((b) => !boardId || b.boardId === boardId).reduce((n, b) => n + b.ops.length, 0);
  }

  pendingOps(boardId) {
    return this.pending.filter((b) => b.boardId === boardId).flatMap((b) => b.ops);
  }

  /** 変更を送る。短い間隔の変更はまとめて1回で送る */
  send(boardId, ops) {
    if (!ops.length) return;
    if (!this.outbox.has(boardId)) this.outbox.set(boardId, []);
    this.outbox.get(boardId).push(...ops);
    if (!this.outboxTimer) this.outboxTimer = setTimeout(() => this.flushOutbox(), FLUSH_MS);
  }

  flushOutbox() {
    clearTimeout(this.outboxTimer);
    this.outboxTimer = null;
    for (const [boardId, ops] of this.outbox) {
      // 同じ要素への連続した変更は最後のものだけ送ればよい
      const last = new Map();
      for (const op of ops) last.set(`${op.k}:${op.id}`, op);
      const batch = { bid: uid(), boardId, ops: [...last.values()] };
      this.pending.push(batch);
      this.raw({ type: 'ops', ...batch });
    }
    this.outbox.clear();
    this.persist();
    this.emit('pending', this.pending.length);
  }

  flushNow() {
    this.flushOutbox();
    this.persist.flush();
  }
}
