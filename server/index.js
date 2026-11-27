// フローチャートアプリのサーバー。
//  - public/ と shared/ の静的ファイル配信
//  - WebSocket（/ws）によるボードのリアルタイム同期
//  - 手書き文字認識の中継（/api/recognize）
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { BoardStore } from './store.js';
import { normalizeItems, recognizeHandwriting } from './handwriting.js';
import { boardSummary, isValidId } from '../public/shared/ops.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.FLOW_TOKEN || '';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const STATIC_ROOTS = [{ prefix: '/', dir: path.join(ROOT, 'public') }];

export async function createServer({ dataDir = DATA_DIR, token = TOKEN, recognize = recognizeHandwriting } = {}) {
  const store = new BoardStore(dataDir);
  await store.load();

  const checkToken = (given) => {
    if (!token) return true;
    if (typeof given !== 'string') return false;
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        // GitHub Pages など、別の場所から開いたアプリからも使えるようにする（認証は合言葉で行う）
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Flow-Token');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.setHeader('Access-Control-Max-Age', '86400');
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          return res.end();
        }
        return await handleApi(req, res, url);
      }
      return await serveStatic(req, res, url);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    }
  });

  async function handleApi(req, res, url) {
    if (url.pathname === '/api/config') return sendJson(res, 200, { auth: Boolean(token) });
    if (!checkToken(req.headers['x-flow-token'] || url.searchParams.get('token'))) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }
    if (url.pathname === '/api/boards' && req.method === 'GET') {
      return sendJson(res, 200, { boards: store.list() });
    }
    const m = url.pathname.match(/^\/api\/boards\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const board = isValidId(m[1]) && store.get(m[1]);
      return board ? sendJson(res, 200, board) : sendJson(res, 404, { error: 'not found' });
    }
    if (url.pathname === '/api/recognize' && req.method === 'POST') {
      const body = await readJson(req, 4 * 1024 * 1024);
      const items = normalizeItems(body?.items);
      if (!items) return sendJson(res, 400, { error: 'invalid ink' });
      try {
        // 各行の候補一覧。results は1つ目の候補（古いアプリとの互換のため）
        const candidates = (await recognize(items, body.lang)).map((c) => (Array.isArray(c) ? c : c ? [c] : []));
        return sendJson(res, 200, { results: candidates.map((c) => c[0] ?? null), candidates });
      } catch (err) {
        console.warn('[recognize] 手書き認識サービスに接続できませんでした:', err.message);
        return sendJson(res, 502, { error: 'recognition service unavailable' });
      }
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  // ---------- WebSocket 同期 ----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws' || !checkToken(url.searchParams.get('token'))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const send = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg, filter = () => true) => {
    const data = JSON.stringify(msg);
    for (const ws of wss.clients) if (ws.readyState === ws.OPEN && filter(ws)) ws.send(data);
  };
  const broadcastBoards = () => broadcast({ type: 'boards', boards: store.list() });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.boardId = null;
    ws.on('pong', () => (ws.isAlive = true));
    send(ws, { type: 'boards', boards: store.list() });

    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const id = msg.boardId;

      switch (msg.type) {
        case 'join': {
          if (!isValidId(id)) return;
          const existed = Boolean(store.get(id));
          const board = store.ensure(id, msg.name);
          if (!board) return send(ws, { type: 'board-deleted', boardId: id });
          ws.boardId = id;
          send(ws, { type: 'snapshot', board });
          if (!existed) broadcastBoards();
          break;
        }
        case 'ensure': {
          if (!isValidId(id)) return;
          const existed = Boolean(store.get(id));
          const board = store.ensure(id, msg.name);
          if (!board) return send(ws, { type: 'board-deleted', boardId: id });
          if (!existed) broadcastBoards();
          break;
        }
        case 'ops': {
          if (!isValidId(id)) return;
          if (!store.get(id)) {
            if (store.isDeleted(id)) send(ws, { type: 'board-deleted', boardId: id });
            send(ws, { type: 'ack', bid: msg.bid, boardId: id });
            return;
          }
          const before = boardSummary(store.get(id)).nodeCount;
          const applied = store.applyOps(id, msg.ops);
          if (applied.length) {
            broadcast({ type: 'ops', boardId: id, ops: applied }, (c) => c !== ws && c.boardId === id);
          }
          send(ws, { type: 'ack', bid: msg.bid, boardId: id });
          if (boardSummary(store.get(id)).nodeCount !== before) scheduleBoardsBroadcast();
          break;
        }
        case 'rename': {
          if (!isValidId(id) || !store.rename(id, msg.name)) return;
          broadcastBoards();
          break;
        }
        case 'delete': {
          if (!isValidId(id)) return;
          if (await store.remove(id)) {
            broadcast({ type: 'board-deleted', boardId: id });
            broadcastBoards();
          }
          break;
        }
        default:
          break;
      }
    });
  });

  let boardsTimer = null;
  function scheduleBoardsBroadcast() {
    if (boardsTimer) return;
    boardsTimer = setTimeout(() => {
      boardsTimer = null;
      broadcastBoards();
    }, 1500);
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  async function close() {
    clearInterval(heartbeat);
    clearTimeout(boardsTimer);
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => server.close(r));
    await store.flush();
  }

  return { server, store, close };
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { error: 'bad path' });
  }
  if (pathname === '/') pathname = '/index.html';
  const root = STATIC_ROOTS.find((r) => pathname.startsWith(r.prefix));
  const file = path.resolve(root.dir, '.' + pathname.slice(root.prefix.length - 1));
  if (!file.startsWith(root.dir + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
  let info;
  try {
    info = await stat(file);
  } catch {
    return sendJson(res, 404, { error: 'not found' });
  }
  if (!info.isFile()) return sendJson(res, 404, { error: 'not found' });
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = await createServer();
  app.server.listen(PORT, HOST, () => {
    console.log(`フローチャートアプリを起動しました`);
    console.log(`  この PC から:        http://localhost:${PORT}`);
    for (const ip of lanAddresses()) console.log(`  タブレットなどから:  http://${ip}:${PORT}`);
    console.log(`  データ保存先:        ${DATA_DIR}`);
    if (TOKEN) console.log('  合言葉（FLOW_TOKEN）が設定されています');
  });
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
