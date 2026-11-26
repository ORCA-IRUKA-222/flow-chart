// GitHub のリポジトリをデータの保存先にする同期（PC やサーバーは不要）。
//
// リポジトリの中身:
//   boards/<ボードID>.json   ボード1つ分（ノード・線・名前）
//   boards/_deleted.json     削除したボードの ID 一覧（古い端末から復活させないため）
//
// 各端末は、開いている間は一定間隔で一覧を確認し、変わったボードだけ取り込む。
// 自分の変更は少し待ってから書き込む。書き込みが他の端末とぶつかったら、
// 最新を取り込んで合成してから書き直す（要素ごとに新しい方が残るので、何度合成しても安全）。
import { boardSummary, isValidId, mergeBoards, hasNewer, pruneTombstones } from '../shared/ops.js';
import { idbGet, idbSet } from './idb.js';
import { debounce } from './util.js';

const POLL_MS = 10000;
const PUSH_DELAY_MS = 2000;
export const GITHUB_API = 'https://api.github.com';

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** GitHub の REST API を呼ぶ（共通） */
export async function githubRequest({ api = GITHUB_API, token, method = 'GET', path, body, accept, etag }) {
  const headers = { Accept: accept || 'application/vnd.github+json', Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';
  if (etag) headers['If-None-Match'] = etag;
  const res = await fetch(`${api}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 304) return { status: 304, res };
  if (res.status === 404) return { status: 404, res };
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      msg = (await res.json()).message || msg;
    } catch {
      // 無視
    }
    throw new HttpError(res.status, msg);
  }
  return { status: res.status, res };
}

/** 設定画面での確認用: リポジトリに書き込めるか */
export async function checkRepo({ api = GITHUB_API, repo, token }) {
  try {
    const r = await githubRequest({ api, token, path: `/repos/${repo}` });
    if (r.status === 404) return { ok: false, reason: 'notfound' };
    const json = await r.res.json();
    if (json.permissions && !json.permissions.push) return { ok: false, reason: 'readonly' };
    return { ok: true, private: Boolean(json.private) };
  } catch (err) {
    if (err.status === 401) return { ok: false, reason: 'token' };
    if (err.status === 403) return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'network' };
  }
}

/** このリポジトリへ初めて同期する前に、端末内のボードを「送るもの」として登録する */
export async function markForUpload(repo, boards) {
  const key = `gh:${repo}`;
  const s = (await idbGet(key)) || {};
  s.localCreated = { ...(s.localCreated || {}) };
  for (const b of boards) s.localCreated[b.id] = b.name;
  await idbSet(key, s);
}

export class GitHubSync extends EventTarget {
  constructor({ repo, token, api = GITHUB_API, getCurrent }) {
    super();
    this.repo = repo;
    this.token = token;
    this.api = api;
    this.getCurrent = getCurrent; // () => 開いているボードのオブジェクト
    this.status = 'connecting';
    this.boardId = null;
    this.known = {}; // id -> { sha, name, updatedAt, nodeCount }  GitHub 上の状態
    this.dirty = {}; // id -> 変更回数（まだ書き込んでいない変更がある）
    this.localCreated = {}; // まだ GitHub にないボード
    this.deletes = []; // まだ GitHub に反映していない削除
    this.remoteDeleted = [];
    this.deletedSha = null;
    this.listEtag = null;
    this.listing = null;
    this.forceFetch = new Set();
    this.running = false;
    this.again = false;
    this.stopped = false;
    this.lastSync = 0;
    this.persist = debounce(() => this.save(), 300);
    this.pushSoon = debounce(() => this.syncSoon(), PUSH_DELAY_MS);
  }

  get enabled() {
    return true;
  }

  get apiServer() {
    return null;
  }

  get label() {
    return `GitHub（${this.repo}）`;
  }

  get online() {
    return this.status === 'online';
  }

  get stateKey() {
    return `gh:${this.repo}`;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  async init() {
    const s = (await idbGet(this.stateKey)) || {};
    this.known = s.known || {};
    this.dirty = s.dirty || {};
    this.localCreated = s.localCreated || {};
    this.deletes = s.deletes || [];
    this.remoteDeleted = s.remoteDeleted || [];
    this.deletedSha = s.deletedSha || null;
  }

  async save() {
    if (this.stopped) return;
    await idbSet(this.stateKey, {
      known: this.known,
      dirty: this.dirty,
      localCreated: this.localCreated,
      deletes: this.deletes,
      remoteDeleted: this.remoteDeleted,
      deletedSha: this.deletedSha,
    });
  }

  async stop() {
    this.persist.flush();
    await this.save();
    this.stopped = true;
    clearInterval(this.timer);
  }

  connect() {
    this.syncSoon();
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (document.visibilityState === 'visible') this.syncSoon();
    }, POLL_MS);
  }

  reconnectNow() {
    this.syncSoon();
  }

  // ---------- アプリからの呼び出し（サーバー同期と同じ形） ----------
  join(boardId) {
    this.boardId = boardId;
    this.forceFetch.add(boardId);
    this.syncSoon();
  }

  ensure(boardId, name) {
    this.localCreated[boardId] = name;
    this.markDirty(boardId);
  }

  async rename(boardId, name) {
    const u = Date.now();
    const cur = this.getCurrent();
    if (cur && cur.id === boardId) {
      cur.name = name;
      cur.nameU = Math.max(u, (cur.nameU || 0) + 1);
    } else {
      const b = await idbGet(`board:${boardId}`);
      if (b) {
        b.name = name;
        b.nameU = Math.max(u, (b.nameU || 0) + 1);
        await idbSet(`board:${boardId}`, b);
      }
    }
    if (this.localCreated[boardId]) this.localCreated[boardId] = name;
    this.markDirty(boardId);
  }

  remove(boardId) {
    delete this.localCreated[boardId];
    delete this.dirty[boardId];
    if (!this.deletes.includes(boardId)) this.deletes.push(boardId);
    this.persist();
    this.emit('pending');
    this.syncSoon();
    return true;
  }

  send(boardId) {
    this.markDirty(boardId);
  }

  markDirty(boardId) {
    this.dirty[boardId] = (this.dirty[boardId] || 0) + 1;
    this.persist();
    this.emit('pending');
    this.pushSoon();
  }

  flushNow() {
    this.persist.flush();
    if (Object.keys(this.dirty).length || this.deletes.length) this.pushSoon.flush();
  }

  pendingOps() {
    return [];
  }

  pendingCount() {
    return Object.keys(this.dirty).length + this.deletes.length;
  }

  raw() {}

  // ---------- 同期の本体 ----------
  syncSoon() {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.run();
  }

  async run() {
    this.running = true;
    if (this.status !== 'online') this.setStatus('connecting');
    do {
      this.again = false;
      try {
        await this.cycle();
        this.lastSync = Date.now();
        this.setStatus('online');
      } catch (err) {
        if (err.status === 401 || err.status === 403) {
          this.setStatus('error');
          this.emit('error', err.status === 401 ? 'GitHub のトークンが無効です。同期の設定を確認してください' : `GitHub に拒否されました（${err.message}）`);
        } else {
          this.setStatus('offline');
        }
        break;
      }
    } while (this.again && !this.stopped);
    this.running = false;
    this.persist();
    this.emit('pending');
  }

  req(opts) {
    return githubRequest({ api: this.api, token: this.token, ...opts });
  }

  path(name) {
    return `/repos/${this.repo}/contents/boards/${name}.json`;
  }

  /** boards/ の一覧（ID → sha）。前回から変わっていなければ通信量の少ない 304 で済む */
  async list() {
    const r = await this.req({ path: `/repos/${this.repo}/contents/boards`, etag: this.listing ? this.listEtag : null });
    if (r.status === 304) return this.listing;
    const files = new Map();
    let deletedSha = null;
    if (r.status !== 404) {
      this.listEtag = r.res.headers.get('ETag');
      for (const f of await r.res.json()) {
        if (f.type !== 'file' || !f.name.endsWith('.json')) continue;
        const id = f.name.slice(0, -5);
        if (id === '_deleted') deletedSha = f.sha;
        else if (isValidId(id)) files.set(id, f.sha);
      }
    }
    this.listing = { files, deletedSha };
    return this.listing;
  }

  /** ファイルを読む（大きいファイルは raw で読み直す） */
  async getFile(name) {
    const r = await this.req({ path: this.path(name) });
    if (r.status === 404) return null;
    const meta = await r.res.json();
    let text;
    if (meta.encoding === 'base64' && meta.content) {
      text = b64decode(meta.content);
    } else {
      const raw = await this.req({ path: this.path(name), accept: 'application/vnd.github.raw+json' });
      text = await raw.res.text();
    }
    return { sha: meta.sha, data: JSON.parse(text) };
  }

  async putFile(name, data, sha, message) {
    const body = { message, content: b64encode(JSON.stringify(data)) };
    if (sha) body.sha = sha;
    const r = await this.req({ method: 'PUT', path: this.path(name), body });
    return (await r.res.json()).content.sha;
  }

  async cycle() {
    const listing = await this.list();

    // 他の端末で削除されたボード
    if (listing.deletedSha && listing.deletedSha !== this.deletedSha) {
      const f = await this.getFile('_deleted');
      this.remoteDeleted = Array.isArray(f?.data?.ids) ? f.data.ids.filter(isValidId) : [];
      this.deletedSha = f?.sha || null;
    }
    // この端末で削除したボード
    if (this.deletes.length) await this.pushDeletes(listing);
    for (const id of this.remoteDeleted) {
      if (this.known[id] || this.localCreated[id] || this.dirty[id]) {
        delete this.known[id];
        delete this.localCreated[id];
        delete this.dirty[id];
        this.emit('board-deleted', id);
      }
    }

    // 開いているボードを先に
    const ids = new Set([...listing.files.keys(), ...Object.keys(this.localCreated), ...Object.keys(this.dirty)]);
    const order = [...ids].sort((a, b) => (a === this.boardId ? -1 : b === this.boardId ? 1 : 0));
    let changed = false;
    for (const id of order) {
      if (this.remoteDeleted.includes(id) || this.deletes.includes(id)) continue;
      changed = (await this.syncBoard(id, listing.files.get(id) || null)) || changed;
    }
    // GitHub 上で消えた（直接ファイルを消したなど）ボードは一覧から外す
    for (const id of Object.keys(this.known)) {
      if (!listing.files.has(id) && !this.localCreated[id] && !this.dirty[id]) {
        delete this.known[id];
        changed = true;
      }
    }
    this.emit('boards', this.boardList());
    return changed;
  }

  boardList() {
    return Object.entries(this.known)
      .map(([id, k]) => ({ id, name: k.name, updatedAt: k.updatedAt, nodeCount: k.nodeCount }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async loadLocal(id) {
    const cur = this.getCurrent();
    if (cur && cur.id === id && this.boardId === id) return cur;
    return (await idbGet(`board:${id}`)) || null;
  }

  /** GitHub の内容を端末側に取り込み、合成後のボードを返す */
  async mergeIntoLocal(id, local, remote) {
    const cur = this.getCurrent();
    if (cur && cur.id === id && this.boardId === id) {
      const ops = [];
      for (const k of ['node', 'edge']) {
        const coll = (k === 'node' ? remote.nodes : remote.edges) || {};
        for (const eid in coll) {
          const e = coll[eid];
          const { u, c, deleted, id: _id, ...v } = e;
          ops.push(deleted ? { t: 'del', k, id: eid, u, c } : { t: 'put', k, id: eid, v, u, c });
        }
      }
      if ((remote.nameU || 0) > (cur.nameU || 0)) {
        cur.name = remote.name;
        cur.nameU = remote.nameU;
        this.emit('renamed', { id, name: remote.name });
      }
      if (ops.length) this.emit('ops', ops);
      return cur;
    }
    const merged = mergeBoards(local, remote);
    await idbSet(`board:${id}`, merged);
    return merged;
  }

  async syncBoard(id, remoteSha) {
    let local = await this.loadLocal(id);
    let remote = null;
    const k = this.known[id];
    if (remoteSha && (!k || k.sha !== remoteSha || this.forceFetch.has(id))) {
      const f = await this.getFile(id);
      if (f) {
        remote = f.data;
        local = await this.mergeIntoLocal(id, local, remote);
        this.known[id] = { ...summary(remote), sha: f.sha };
      }
      this.forceFetch.delete(id);
    }
    const needPush =
      local &&
      (!remoteSha || this.dirty[id] !== undefined || this.localCreated[id] !== undefined || (remote && hasNewer(local, remote)));
    if (needPush) await this.pushBoard(id, local);
    return Boolean(remote || needPush);
  }

  async pushBoard(id, local, tries = 0) {
    const version = this.dirty[id];
    const data = serialize(local);
    try {
      const sha = await this.putFile(id, data, this.known[id]?.sha, `更新: ${data.name || id}`);
      this.known[id] = { ...summary(data), sha };
      this.listing?.files.set(id, sha); // この周回の「GitHub 上にあるもの」に加える
      if (this.dirty[id] === version) delete this.dirty[id];
      delete this.localCreated[id];
      this.persist();
    } catch (err) {
      // 他の端末が先に書き込んだ → 最新を取り込んで合成し、書き直す
      if ((err.status === 409 || err.status === 422) && tries < 4) {
        const f = await this.getFile(id);
        if (f) {
          local = await this.mergeIntoLocal(id, local, f.data);
          this.known[id] = { ...summary(f.data), sha: f.sha };
        } else if (this.known[id]) {
          delete this.known[id].sha;
        }
        return this.pushBoard(id, local, tries + 1);
      }
      throw err;
    }
  }

  async pushDeletes(listing, tries = 0) {
    const ids = [...this.deletes];
    const f = await this.getFile('_deleted');
    const all = [...new Set([...(Array.isArray(f?.data?.ids) ? f.data.ids : []), ...ids])];
    try {
      this.deletedSha = await this.putFile('_deleted', { ids: all }, f?.sha, `削除: ${ids.join(', ')}`);
    } catch (err) {
      if ((err.status === 409 || err.status === 422) && tries < 4) return this.pushDeletes(listing, tries + 1);
      throw err;
    }
    this.remoteDeleted = all;
    for (const id of ids) {
      const sha = listing.files.get(id);
      if (sha) {
        await this.req({ method: 'DELETE', path: this.path(id), body: { message: `削除: ${id}`, sha } }).catch(() => {});
        listing.files.delete(id);
      }
      delete this.known[id];
    }
    this.deletes = this.deletes.filter((x) => !ids.includes(x));
    this.persist();
  }
}

function summary(board) {
  const s = boardSummary(board);
  return { name: s.name, updatedAt: s.updatedAt, nodeCount: s.nodeCount };
}

function serialize(board) {
  const copy = {
    format: 'flowchart-board',
    version: 1,
    id: board.id,
    name: board.name,
    nameU: board.nameU || 0,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    nodes: { ...board.nodes },
    edges: { ...board.edges },
  };
  pruneTombstones(copy);
  return copy;
}
