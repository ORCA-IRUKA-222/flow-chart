import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createServer } from '../server/index.js';
import { applyOp, emptyBoard } from '../shared/ops.js';
import { normalizeItems, parseResponse } from '../server/handwriting.js';

function client(port, token = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ''}`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    inbox.push(msg);
    for (const w of [...waiters]) {
      if (w.pred(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  return {
    ws,
    open: () => new Promise((r, j) => (ws.once('open', r), ws.once('error', j))),
    send: (m) => ws.send(JSON.stringify(m)),
    wait: (pred, ms = 2000) =>
      new Promise((resolve, reject) => {
        const hit = inbox.find(pred);
        if (hit) return resolve(hit);
        const t = setTimeout(() => reject(new Error('timeout')), ms);
        waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
      }),
  };
}

async function start(opts = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'flow-'));
  const app = await createServer({ dataDir: dir, ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  return { ...app, dir, port: app.server.address().port };
}

const node = (id, x, u, c = 'a') => ({ t: 'put', k: 'node', id, v: { x, y: 0, w: 100, h: 50, text: id }, u, c });

test('LWW: 届く順番が違っても同じ状態になる', () => {
  const ops = [node('n1', 10, 5, 'a'), node('n1', 20, 5, 'b'), node('n1', 0, 3, 'c'), { t: 'del', k: 'node', id: 'n2', u: 9, c: 'a' }, node('n2', 1, 8)];
  const a = emptyBoard('x');
  const b = emptyBoard('x');
  ops.forEach((op) => applyOp(a, op));
  [...ops].reverse().forEach((op) => applyOp(b, op));
  assert.deepEqual(a.nodes, b.nodes);
  assert.equal(a.nodes.n1.x, 20);
  assert.equal(a.nodes.n2.deleted, true);
  assert.equal(applyOp(a, { t: 'put', k: 'node', id: '__proto__', v: {}, u: 99 }), false);
});

test('2つの端末の間で変更が同期され、ファイルに保存される', async () => {
  const app = await start();
  try {
    const a = client(app.port);
    const b = client(app.port);
    await Promise.all([a.open(), b.open()]);
    a.send({ type: 'join', boardId: 'board1', name: 'テスト' });
    await a.wait((m) => m.type === 'snapshot');
    b.send({ type: 'join', boardId: 'board1' });
    await b.wait((m) => m.type === 'snapshot');
    a.send({ type: 'ops', boardId: 'board1', bid: 'b1', ops: [node('n1', 10, Date.now())] });
    await a.wait((m) => m.type === 'ack' && m.bid === 'b1');
    const got = await b.wait((m) => m.type === 'ops');
    assert.equal(got.ops[0].id, 'n1');
    const list = await b.wait((m) => m.type === 'boards' && m.boards.some((x) => x.name === 'テスト'));
    assert.ok(list);
    a.ws.close();
    b.ws.close();
  } finally {
    await app.close();
  }
  // 再起動しても残っている
  const again = await createServer({ dataDir: app.dir });
  assert.equal(again.store.get('board1').nodes.n1.x, 10);
  await again.close().catch(() => {});
  await rm(app.dir, { recursive: true, force: true });
});

test('削除したボードは、古い端末から送られても復活しない', async () => {
  const app = await start();
  try {
    const a = client(app.port);
    await a.open();
    a.send({ type: 'join', boardId: 'gone', name: 'x' });
    await a.wait((m) => m.type === 'snapshot');
    a.send({ type: 'delete', boardId: 'gone' });
    await a.wait((m) => m.type === 'board-deleted');
    const b = client(app.port);
    await b.open();
    b.send({ type: 'join', boardId: 'gone', name: 'x' });
    await b.wait((m) => m.type === 'board-deleted');
    assert.equal(app.store.get('gone'), null);
    a.ws.close();
    b.ws.close();
  } finally {
    await app.close();
    await rm(app.dir, { recursive: true, force: true });
  }
});

test('合言葉（FLOW_TOKEN）がないと接続できない', async () => {
  const app = await start({ token: 'secret' });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/boards`);
    assert.equal(res.status, 401);
    const ok = await fetch(`http://127.0.0.1:${app.port}/api/boards`, { headers: { 'x-flow-token': 'secret' } });
    assert.equal(ok.status, 200);
    await assert.rejects(client(app.port, 'wrong').open());
    const c = client(app.port, 'secret');
    await c.open();
    c.ws.close();
  } finally {
    await app.close();
    await rm(app.dir, { recursive: true, force: true });
  }
});

test('文字認識の中継: 入力の検証と、結果の取り出し', async () => {
  assert.equal(normalizeItems([{ w: 10, h: 10, ink: [[[1, 'x'], [2]]] }]), null);
  const items = normalizeItems([{ w: 100, h: 50, ink: [[[1, 2], [3, 4], [0, 10]]] }]);
  assert.equal(items.length, 1);
  assert.equal(parseResponse(['SUCCESS', [['id', ['開始', '閉始'], [], {}]]]), '開始');
  assert.equal(parseResponse(['FAILED']), null);

  const app = await start({ recognize: async (list) => list.map(() => 'はい') });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/recognize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ w: 100, h: 50, ink: [[[1, 2], [3, 4]]] }] }),
    });
    assert.deepEqual(await res.json(), { results: ['はい'] });
  } finally {
    await app.close();
    await rm(app.dir, { recursive: true, force: true });
  }
});
