// GitHub 同期のテスト（本物の GitHub の代わりに test/fake-github.js を使う）
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeGitHub } from './fake-github.js';
import { GitHubSync, checkRepo } from '../public/js/github-sync.js';
import { idbGet, idbSet } from '../public/js/idb.js';
import { emptyBoard } from '../public/shared/ops.js';

const node = (id, text, u, c = 'dev1') => ({ id, x: 0, y: 0, w: 140, h: 60, shape: 'rect', color: 'default', text, z: 0, u, c });

async function device(gh, opts = {}) {
  const s = new GitHubSync({ repo: 'owner/data', token: 'good-token', api: gh.api, getCurrent: () => null, ...opts });
  await s.init();
  return s;
}

test('リポジトリの確認: トークン違い・存在しない・公開', async () => {
  const gh = await startFakeGitHub({ isPrivate: false });
  try {
    assert.deepEqual(await checkRepo({ api: gh.api, repo: 'owner/data', token: 'good-token' }), { ok: true, private: false });
    assert.equal((await checkRepo({ api: gh.api, repo: 'owner/data', token: 'bad' })).reason, 'token');
    assert.equal((await checkRepo({ api: gh.api, repo: 'owner/none', token: 'good-token' })).reason, 'notfound');
  } finally {
    await gh.close();
  }
});

test('端末のボードを GitHub に書き込み、他の端末の変更とぶつかっても合成する', async () => {
  const gh = await startFakeGitHub();
  try {
    const board = emptyBoard('b1', 'テスト');
    board.nodes.n1 = node('n1', 'はじめ', 100);
    await idbSet('board:b1', board);
    const s = await device(gh);
    s.ensure('b1', 'テスト');
    await s.run();
    assert.equal(s.status, 'online');
    assert.equal(gh.read('boards/b1.json').nodes.n1.text, 'はじめ');
    assert.equal(s.pendingCount(), 0);

    // 他の端末が n2 を追加し、n1 を書き換えた
    const remote = gh.read('boards/b1.json');
    remote.nodes.n2 = node('n2', '他の端末', 200, 'dev2');
    remote.nodes.n1 = node('n1', '他の端末で変更', 300, 'dev2');
    gh.write('boards/b1.json', remote);
    // 同じころ、この端末で n3 を追加（まだ取り込んでいないので、書き込みは sha が合わず拒否される）
    const local = await idbGet('board:b1');
    local.nodes.n3 = node('n3', 'この端末', 250);
    await idbSet('board:b1', local);
    s.dirty.b1 = 1;
    s.known.b1.sha = s.known.b1.sha; // 古い sha のまま
    await s.pushBoard('b1', local);
    const merged = gh.read('boards/b1.json');
    assert.deepEqual(Object.keys(merged.nodes).sort(), ['n1', 'n2', 'n3']);
    assert.equal(merged.nodes.n1.text, '他の端末で変更');
    const cached = await idbGet('board:b1');
    assert.equal(cached.nodes.n2.text, '他の端末');
  } finally {
    await gh.close();
  }
});

test('他の端末で消したボードは、この端末からも消える', async () => {
  const gh = await startFakeGitHub();
  try {
    await idbSet('board:b2', emptyBoard('b2', '消える'));
    const s = await device(gh);
    s.ensure('b2', '消える');
    await s.run();
    const deleted = [];
    s.addEventListener('board-deleted', (e) => deleted.push(e.detail));
    gh.write('boards/_deleted.json', { ids: ['b2'] });
    gh.files.delete('boards/b2.json');
    await s.run();
    assert.deepEqual(deleted, ['b2']);
    assert.equal(s.boardList().some((b) => b.id === 'b2'), false);
  } finally {
    await gh.close();
  }
});

test('この端末での削除は、削除一覧に記録してファイルも消す', async () => {
  const gh = await startFakeGitHub();
  try {
    await idbSet('board:b3', emptyBoard('b3', 'x'));
    const s = await device(gh);
    s.ensure('b3', 'x');
    await s.run();
    assert.ok(gh.read('boards/b3.json'));
    s.remove('b3');
    await s.run();
    assert.equal(gh.read('boards/b3.json'), null);
    assert.deepEqual(gh.read('boards/_deleted.json').ids, ['b3']);
  } finally {
    await gh.close();
  }
});

test('トークンが無効になったら、エラーとして知らせる', async () => {
  const gh = await startFakeGitHub();
  try {
    const s = new GitHubSync({ repo: 'owner/data', token: 'expired', api: gh.api, getCurrent: () => null });
    await s.init();
    const errors = [];
    s.addEventListener('error', (e) => errors.push(e.detail));
    await s.run();
    assert.equal(s.status, 'error');
    assert.equal(errors.length, 1);
  } finally {
    await gh.close();
  }
});
