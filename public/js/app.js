// アプリ全体のつなぎ込み: ボード一覧・同期・ツールバー・手書き整形
import { COLORS, emptyBoard, isValidId } from '../shared/ops.js';
import { Canvas } from './canvas.js';
import { Doc } from './doc.js';
import { recognizeLines } from './handwriting.js';
import { idbDel, idbGet, idbSet } from './idb.js';
import { alignNodes, analyzeInk, splitLines, tidyBox, unifySizes } from './recognize.js';
import { Sync } from './sync.js';
import { GitHubSync, checkRepo, markForUpload } from './github-sync.js';
import {
  getSyncConfig,
  githubApi,
  githubToken,
  isBlockedMixedContent,
  normalizeRepo,
  normalizeServer,
  resolveServer,
  serverSetting,
  setGithubToken,
  setSyncConfig,
} from './config.js';
import { rectsIntersect, snap } from './geometry.js';
import { debounce, el, hideToast, toast, uid } from './util.js';

const $ = (id) => document.getElementById(id);

// アプリを更新したら、sw.js の CACHE と一緒に変える
export const APP_VERSION = '2026.11.27-1';

const clientId = (() => {
  let id = localStorage.getItem('fc:client');
  if (!id) {
    id = uid(10);
    localStorage.setItem('fc:client', id);
  }
  return id;
})();

const state = {
  boards: [], // [{ id, name, updatedAt, nodeCount }]
  currentId: null,
  inkByBoard: new Map(),
  token: localStorage.getItem('fc:token') || '',
};

const doc = new Doc(clientId);
const canvas = new Canvas($('viewport'), doc);
let sync;

// ---------- ダイアログ ----------
function ask(title, value = '', { type = 'text', okLabel = 'OK' } = {}) {
  const dlg = $('dialog');
  $('dialogTitle').textContent = title;
  const input = $('dialogInput');
  input.type = type;
  input.value = value;
  $('dialogOk').textContent = okLabel;
  dlg.returnValue = '';
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? input.value.trim() : null), { once: true });
    dlg.showModal();
    input.select();
  });
}

// ---------- 認証（FLOW_TOKEN が設定されているサーバーのみ） ----------
async function ensureAuth(server) {
  if (!server) return;
  let cfg = { auth: false };
  try {
    cfg = await (await fetch(`${server}/api/config`, { signal: AbortSignal.timeout(5000) })).json();
  } catch {
    return; // オフライン
  }
  if (!cfg.auth) return;
  for (;;) {
    try {
      const res = await fetch(`${server}/api/boards`, { headers: { 'x-flow-token': state.token } });
      if (res.status !== 401) return;
    } catch {
      return;
    }
    const t = await ask('合言葉を入力してください（サーバーの FLOW_TOKEN）', '', { type: 'password' });
    if (t === null) return;
    state.token = t;
    localStorage.setItem('fc:token', t);
  }
}

// ---------- ボード一覧 ----------
function boardName(id) {
  return state.boards.find((b) => b.id === id)?.name || doc.board.name || '無題のボード';
}

function renderBoardList() {
  const list = $('boardList');
  list.replaceChildren(
    ...state.boards.map((b) => {
      const li = el(
        'li',
        { class: b.id === state.currentId ? 'active' : '', title: b.name },
        el('span', { class: 'b-name' }, b.name, el('br'), el('span', { class: 'b-meta' }, boardMeta(b))),
        el(
          'span',
          { class: 'b-actions' },
          el('button', { class: 'icon-btn mini', title: '名前を変更', 'aria-label': '名前を変更', 'data-act': 'rename' }, icon('M4 20h4L19 9l-4-4L4 16zM13 7l4 4')),
          el('button', { class: 'icon-btn mini', title: '削除', 'aria-label': '削除', 'data-act': 'delete' }, icon('M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3')),
        ),
      );
      li.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'rename') renameBoard(b.id);
        else if (act === 'delete') deleteBoard(b.id);
        else {
          openBoard(b.id);
          if (window.matchMedia('(max-width: 900px)').matches) toggleSidebar(false);
        }
      });
      return li;
    }),
  );
}

function boardMeta(b) {
  const parts = [];
  if (typeof b.nodeCount === 'number') parts.push(`${b.nodeCount} ノード`);
  if (b.updatedAt) parts.push(new Date(b.updatedAt).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
  if (b.local && sync?.enabled) parts.push('未同期');
  return parts.join(' · ');
}

function icon(d) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  s.append(p);
  return s;
}

function setBoards(list) {
  const local = Object.entries(sync?.localCreated || {})
    .filter(([id]) => !list.some((b) => b.id === id))
    .map(([id, name]) => ({ id, name, local: true, updatedAt: Date.now() }));
  state.boards = [...local, ...list];
  idbSet('boards', state.boards);
  renderBoardList();
  if (state.currentId) $('boardName').value = boardName(state.currentId);
}

async function createBoard(name, { open = true } = {}) {
  const id = uid(12);
  const n = name || `ボード ${state.boards.length + 1}`;
  sync.ensure(id, n);
  state.boards.unshift({ id, name: n, local: true, updatedAt: Date.now(), nodeCount: 0 });
  renderBoardList();
  await idbSet(`board:${id}`, emptyBoard(id, n));
  if (open) await openBoard(id);
  return id;
}

async function renameBoard(id) {
  const name = await ask('ボード名', boardName(id), { okLabel: '変更' });
  if (name) applyRename(id, name);
}

function applyRename(id, name) {
  sync.rename(id, name);
  const b = state.boards.find((x) => x.id === id);
  if (b) b.name = name;
  if (id === state.currentId) {
    doc.board.name = name;
    $('boardName').value = name;
    saveCache();
  }
  renderBoardList();
}

async function deleteBoard(id) {
  const name = boardName(id);
  const msg = sync.enabled ? '他の端末からも消え、元に戻せません。' : 'この端末から消え、元に戻せません。';
  if (!confirm(`「${name}」を削除しますか？\n${msg}`)) return;
  // オフラインならこの端末からすぐ消し、削除はつながったときにサーバーへ送る
  if (sync.remove(id)) onBoardDeleted(id, { quiet: true });
}

async function onBoardDeleted(id, { quiet = false } = {}) {
  state.boards = state.boards.filter((b) => b.id !== id);
  idbSet('boards', state.boards);
  idbDel(`board:${id}`);
  state.inkByBoard.delete(id);
  renderBoardList();
  if (id === state.currentId) {
    if (!quiet) toast('このボードは削除されました');
    state.currentId = null;
    if (state.boards.length) await openBoard(state.boards[0].id);
    else await createBoard('はじめてのボード');
  }
}

/** 一覧の表示（ノード数・更新日時）を、開いているボードに合わせて更新 */
const touchBoardEntry = debounce(() => {
  const b = state.boards.find((x) => x.id === doc.id);
  if (!b) return;
  b.nodeCount = doc.nodes().length;
  b.updatedAt = Date.now();
  idbSet('boards', state.boards);
  renderBoardList();
}, 800);

// ---------- ボードを開く ----------
const saveCache = debounce(() => {
  if (state.currentId && doc.id === state.currentId) idbSet(`board:${doc.id}`, doc.board);
}, 500);

function saveView() {
  if (state.currentId) localStorage.setItem(`fc:view:${state.currentId}`, JSON.stringify(canvas.view));
}

async function openBoard(id) {
  if (!isValidId(id)) return;
  canvas.finishEdit();
  if (state.currentId) {
    saveView();
    state.inkByBoard.set(state.currentId, canvas.ink);
    saveCache.flush();
  }
  state.currentId = id;
  localStorage.setItem('fc:lastBoard', id);
  const name = state.boards.find((b) => b.id === id)?.name || '無題のボード';
  const cached = (await idbGet(`board:${id}`)) || emptyBoard(id, name);
  if (state.currentId !== id) return;
  doc.load(cached);
  resetHistory();
  doc.applyRemote(sync.pendingOps(id));
  canvas.setInk(state.inkByBoard.get(id) || []);
  $('boardName').value = name;
  renderBoardList();
  const v = localStorage.getItem(`fc:view:${id}`);
  if (v) {
    try {
      canvas.setView(JSON.parse(v));
    } catch {
      canvas.fit();
    }
  } else {
    canvas.fit();
  }
  canvas.render();
  sync.join(id, name);
  updateUndo();
  updateHint();
}

// ---------- 同期の状態表示 ----------
function updateStatus() {
  const s = $('status');
  const pending = sync.pendingCount();
  let label;
  const st = sync.status;
  if (st === 'local') label = 'この端末のみ';
  else if (st === 'online') label = pending ? `送信中 ${pending}` : '同期済み';
  else if (st === 'connecting') label = '同期中…';
  else if (st === 'error') label = '同期エラー';
  else label = pending ? `オフライン（未送信 ${pending}）` : 'オフライン';
  s.dataset.state = st;
  s.querySelector('span').textContent = label;
  s.title =
    st === 'local'
      ? 'この端末だけに保存しています。押すと同期先を設定できます'
      : st === 'online'
        ? `${sync.label} と同期しています`
        : st === 'error'
          ? '同期できません。押して同期の設定を確認してください'
          : '接続が戻ると自動で同期します（押すと同期先を変更できます）';
}

// ---------- 同期の設定 ----------
/** ボードの中身を op の列にする（まだサーバーにないボードを送るとき） */
function boardToOps(board) {
  const ops = [];
  for (const k of ['node', 'edge']) {
    const coll = (k === 'node' ? board.nodes : board.edges) || {};
    for (const id in coll) {
      const e = coll[id];
      const { u, c, deleted, id: _id, ...v } = e;
      ops.push(deleted ? { t: 'del', k, id, u, c } : { t: 'put', k, id, v, u, c });
    }
  }
  return ops;
}

async function uploadBoards(ids) {
  for (const id of ids) {
    const board = id === doc.id ? doc.board : await idbGet(`board:${id}`);
    if (!board) continue;
    const ops = boardToOps(board);
    for (let i = 0; i < ops.length; i += 2000) {
      sync.raw({ type: 'ops', boardId: id, bid: uid(), ops: ops.slice(i, i + 2000) });
    }
  }
}

function currentMode() {
  const cfg = getSyncConfig();
  if (cfg) return cfg.mode;
  return sync.enabled ? 'server' : 'local';
}

function showModeFields() {
  const mode = $('syncForm').querySelector('input[name="mode"]:checked')?.value || 'local';
  document.querySelectorAll('.mode-fields').forEach((f) => (f.hidden = f.dataset.for !== mode));
  $('syncError').textContent = '';
}

function openSyncDialog() {
  const cfg = getSyncConfig();
  const mode = currentMode();
  $('syncForm').querySelector(`input[name="mode"][value="${mode}"]`).checked = true;
  $('ghRepo').value = cfg?.repo || '';
  $('ghToken').value = githubToken();
  $('syncInput').value = cfg?.server || serverSetting() || (sync.apiServer && sync.apiServer !== location.origin ? sync.apiServer : '');
  $('syncCurrent').textContent = sync.enabled ? `現在の同期先: ${sync.label}` : '現在: この端末だけに保存しています';
  showModeFields();
  $('syncDialog').returnValue = '';
  $('syncDialog').showModal();
}

/** 設定を保存し、送信待ちを残したまま読み込み直す */
async function applySyncConfig(cfg, beforeReload) {
  await idbSet(`board:${doc.id}`, doc.board);
  await sync.stop();
  if (beforeReload) await beforeReload();
  setSyncConfig(cfg);
  location.reload();
}

async function saveSyncSetting() {
  const mode = $('syncForm').querySelector('input[name="mode"]:checked')?.value || 'local';
  const err = (m) => {
    $('syncError').textContent = m;
    return false;
  };
  // 中身のないボード（初回に自動で作られたものなど）は送らずに片付ける
  const withContent = [];
  const empty = [];
  for (const b of state.boards) {
    const data = b.id === doc.id ? doc.board : await idbGet(`board:${b.id}`);
    const hasContent = data && (Object.keys(data.nodes || {}).length || Object.keys(data.edges || {}).length);
    (hasContent ? withContent : empty).push(b);
  }
  const boards = withContent.map((b) => ({ id: b.id, name: b.name }));
  const dropEmpty = async () => {
    const created = (await idbGet('localCreated')) || {};
    for (const b of empty) {
      await idbDel(`board:${b.id}`);
      delete created[b.id];
    }
    await idbSet('localCreated', created);
    await idbSet('boards', withContent);
    if (empty.some((b) => b.id === localStorage.getItem('fc:lastBoard'))) localStorage.removeItem('fc:lastBoard');
  };

  if (mode === 'local') {
    await applySyncConfig({ mode: 'local' });
    return true;
  }

  if (mode === 'github') {
    const repo = normalizeRepo($('ghRepo').value);
    const token = $('ghToken').value.trim();
    if (!repo) return err('リポジトリは「ユーザー名/リポジトリ名」の形で入力してください');
    if (!token) return err('アクセストークンを入力してください');
    $('syncError').textContent = '確認しています…';
    const check = await checkRepo({ api: githubApi(), repo, token });
    if (!check.ok) {
      return err(
        {
          notfound: 'リポジトリが見つかりません。名前と、トークンにそのリポジトリへのアクセス権があるかを確認してください',
          token: 'トークンが正しくないか、期限が切れています',
          readonly: 'このトークンでは書き込めません。Contents を「Read and write」にしてください',
          forbidden: 'GitHub に拒否されました。トークンの権限を確認してください',
          network: 'GitHub に接続できません。インターネット接続を確認してください',
        }[check.reason],
      );
    }
    if (!check.private && !confirm(`${repo} は公開リポジトリです。ボードの内容を誰でも見られるようになります。\nこのまま使いますか？（非公開リポジトリをおすすめします）`)) {
      return err('非公開のリポジトリを指定してください');
    }
    setGithubToken(token);
    // 今この端末にあるボードは、GitHub へまるごと送る（すでにあれば合成される）
    await applySyncConfig({ mode: 'github', repo }, async () => {
      await dropEmpty();
      await markForUpload(repo, boards);
    });
    return true;
  }

  // 自分のサーバー
  let origin = '';
  try {
    origin = normalizeServer($('syncInput').value);
  } catch {
    return err('アドレスの形式が正しくありません');
  }
  if (!origin) return err('サーバーのアドレスを入力してください');
  if (isBlockedMixedContent(origin)) {
    return err('このページは https なので、http のサーバーには接続できません。https のアドレスを指定するか、「GitHub に保存」を使ってください');
  }
  try {
    const res = await fetch(`${origin}/api/config`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    if (!confirm(`${origin} に今は接続できません。\nこのまま保存すると、つながったときに同期します。保存しますか？`)) return false;
  }
  await applySyncConfig({ mode: 'server', server: origin }, async () => {
    await dropEmpty();
    // 今この端末にあるボードは、新しい同期先へまるごと送る
    const created = (await idbGet('localCreated')) || {};
    for (const b of boards) created[b.id] = b.name;
    await idbSet('localCreated', created);
  });
  return true;
}

/** 起動時に、設定に合わせて同期の方式を選ぶ */
async function createSync() {
  const cfg = getSyncConfig();
  if (cfg?.mode === 'github' && cfg.repo && githubToken()) {
    return new GitHubSync({ repo: cfg.repo, token: githubToken(), api: githubApi(), getCurrent: () => (state.currentId === doc.id ? doc.board : null) });
  }
  let server = null;
  if (cfg?.mode === 'server') server = cfg.server || null;
  else if (!cfg) server = await resolveServer();
  if (server && isBlockedMixedContent(server)) toast('同期先が http のため接続できません。同期の設定を確認してください', { kind: 'error', duration: 6000 });
  await ensureAuth(server);
  return new Sync({ token: state.token, server });
}

// ---------- 手書き整形（OCR） ----------
let ocrRunning = false;

/**
 * 手書きを整形する。
 * @param mode 'all' = すべて / 'shapes' = 図形と線だけ（文字は手書きのまま） / 'text' = 文字だけ（図形は手書きのまま）
 */
async function runOCR(mode = 'all') {
  if (ocrRunning) return;
  canvas.finishEdit();
  closeOcrMenu();
  const strokes = canvas.ink;
  // 対象にする手書き（文字ペン・図形ペンの区別で絞る。区別のない古い手書きはどちらにも含める）
  const subset = strokes.map((s, i) => i).filter((i) => (mode === 'shapes' ? strokes[i].kind !== 'text' : mode === 'text' ? strokes[i].kind !== 'shape' : true));
  if (!subset.length) {
    toast(
      mode === 'shapes'
        ? '整形する図形の手書きがありません（図形ペンで描いてください）'
        : mode === 'text'
          ? '整形する文字の手書きがありません（文字ペンで書いてください）'
          : 'ペンで図形・矢印・文字を書いてから押してください',
    );
    return;
  }
  ocrRunning = true;
  $('ocrBtn').disabled = true;
  try {
    const boardId = doc.id;
    const existing = doc.nodes();
    const result = analyzeInk(
      subset.map((i) => strokes[i]),
      { nodes: existing, edges: canvas.edgeLines() },
    );
    // 今回は整形しないものは、手書きのまま残す
    const skipped = new Set();
    if (mode === 'shapes') {
      result.texts.forEach((t) => t.idx.forEach((i) => skipped.add(i)));
      result.texts = [];
    } else if (mode === 'text') {
      result.shapes.forEach((sh) => sh.idx.forEach((i) => skipped.add(i)));
      result.connectors.forEach((c) => c.idx.forEach((i) => skipped.add(i)));
      result.texts = result.texts.filter((t) => {
        if (t.target.type === 'shape' || t.target.type === 'connector') {
          t.idx.forEach((i) => skipped.add(i));
          return false;
        }
        return true;
      });
      result.shapes = [];
      result.connectors = [];
    }

    // 文字の認識
    const lines = [];
    const spans = result.texts.map((t) => {
      const ls = splitLines(t.strokes);
      const start = lines.length;
      lines.push(...ls);
      return [start, ls.length];
    });
    const ks = strokes.map((s) => s.k || 1).sort((a, b) => a - b);
    let recog = { results: [], ok: true };
    if (lines.length) {
      toast('文字を認識しています…', { duration: 0 });
      recog = await recognizeLines(lines, { k: ks[Math.floor(ks.length / 2)], token: state.token, server: sync.apiServer });
      hideToast();
    }
    if (doc.id !== boardId) return;
    const textOf = result.texts.map((_, i) => {
      const [start, count] = spans[i];
      return recog.results
        .slice(start, start + count)
        .filter(Boolean)
        .join('\n')
        .trim();
    });

    const keepStrokes = new Set([...result.leftover, ...skipped]);
    const failed = [];
    result.texts.forEach((t, i) => {
      if (!textOf[i]) {
        failed.push(i);
        t.idx.forEach((s) => keepStrokes.add(s));
      }
    });

    const tx = doc.tx();
    let z = doc.maxZ();

    // 図形 → ノード
    let shapeNodes = result.shapes.map((s) => ({ id: uid(), shape: s.shape, color: 'default', text: '', ...tidyBox(s.shape, s.bbox) }));
    result.texts.forEach((t, i) => {
      if (t.target.type === 'shape' && textOf[i]) shapeNodes[t.target.index].text = textOf[i];
    });
    shapeNodes = unifySizes(shapeNodes);
    shapeNodes = shapeNodes.map((n) => ({ ...n, ...canvas.fitSize(n, n.text) }));
    const vis = canvas.visibleWorld(0);
    shapeNodes = alignNodes(
      shapeNodes,
      existing.filter((n) => rectsIntersect(n, vis)),
    ).map((n) => ({ ...n, x: snap(n.x, 5), y: snap(n.y, 5), z: ++z }));
    shapeNodes.forEach((n) => tx.put('node', n));

    // 既存ノードの中に書いた文字 → 文字を追加
    result.texts.forEach((t, i) => {
      if (t.target.type !== 'node' || !textOf[i]) return;
      const n = doc.node(t.target.id);
      const text = n.text ? `${n.text}\n${textOf[i]}` : textOf[i];
      tx.put('node', { id: n.id, text, ...canvas.fitSize(n, text) });
    });

    // 矢印 → 線
    const idOf = (ref) => (ref.type === 'node' ? ref.id : shapeNodes[ref.index].id);
    const labelFor = (type, key) =>
      result.texts
        .map((t, i) => (t.target.type === type && (t.target.index ?? t.target.id) === key ? textOf[i] : ''))
        .filter(Boolean)
        .join(' ');
    let edgeCount = 0;
    result.connectors.forEach((c, index) => {
      const from = idOf(c.from);
      const to = idOf(c.to);
      const label = labelFor('connector', index);
      const exists = doc.edges().find((e) => e.from === from && e.to === to);
      if (exists) {
        if (label) tx.put('edge', { id: exists.id, label });
        return;
      }
      tx.put('edge', { id: uid(), from, to, label, style: 'orthogonal', arrow: true });
      edgeCount++;
    });

    // 既存の線の近くに書いた文字 → ラベル
    result.texts.forEach((t, i) => {
      if (t.target.type === 'edge' && textOf[i]) tx.put('edge', { id: t.target.id, label: textOf[i] });
    });

    // どこにも属さない文字 → テキストノード
    let textCount = 0;
    result.texts.forEach((t, i) => {
      if (t.target.type !== 'free' || !textOf[i]) return;
      const base = { id: uid(), shape: 'text', color: 'default', text: textOf[i], ...tidyBox('text', t.bbox) };
      tx.put('node', { ...base, ...canvas.fitSize(base, base.text), z: ++z });
      textCount++;
    });

    // 整形は「図の変更」と「手書きが消えたこと」を1回の操作として元に戻せるようにする
    let committed = false;
    if (tx.size) {
      suppressDocHistory = true;
      committed = tx.commit().length > 0;
      suppressDocHistory = false;
    }
    // keepStrokes は絞り込んだ一覧の番号なので、元の番号に戻す。対象外だった手書きもそのまま残す
    const keepOriginal = new Set(strokes.map((_, i) => i).filter((i) => !subset.includes(i)));
    keepStrokes.forEach((i) => keepOriginal.add(subset[i]));
    const after = strokes.filter((_, i) => keepOriginal.has(i));
    canvas.setInk(after);
    pushHistory({ doc: committed, ink: { type: 'replace', before: strokes, after } });
    if (shapeNodes.length) canvas.select(shapeNodes.map((n) => n.id));

    const recognizedTexts = result.texts.length - failed.length;
    const keptNote = mode === 'shapes' && after.length ? ' ／ 文字は手書きのまま残しています' : mode === 'text' && after.length ? ' ／ 図形は手書きのまま残しています' : '';
    if (!tx.size && !recognizedTexts) {
      toast(lines.length && !recog.ok ? '文字認識サービスに接続できませんでした' : '図形として認識できませんでした。もう少し大きく、線を閉じて書いてみてください', { kind: 'error', duration: 4000 });
    } else if (lines.length && !recog.ok) {
      toast('図形と線を整えました。文字認識サービスに接続できないため、文字は手書きのまま残しています', { kind: 'error', duration: 5000 });
    } else {
      const parts = [];
      if (shapeNodes.length) parts.push(`図形 ${shapeNodes.length}`);
      if (edgeCount) parts.push(`線 ${edgeCount}`);
      if (recognizedTexts) parts.push(`文字 ${recognizedTexts}`);
      toast(`整形しました（${parts.join('・') || '変更'}）${failed.length ? ' ／ 読めなかった文字は残しています' : keptNote}`, { duration: 3500 });
    }
  } catch (err) {
    console.error(err);
    toast('整形中にエラーが起きました', { kind: 'error' });
  } finally {
    ocrRunning = false;
    $('ocrBtn').disabled = false;
  }
}

// ---------- 選択中ツールバー ----------
const SHAPE_BUTTONS = [
  ['rect', '四角（処理）', 'M4 6h16v12H4z'],
  ['round', '角丸（開始・終了）', 'M9 6h6a6 6 0 010 12H9A6 6 0 019 6z'],
  ['diamond', 'ひし形（分岐）', 'M12 3l9 9-9 9-9-9z'],
  ['ellipse', '楕円', 'M12 6c5 0 9 2.7 9 6s-4 6-9 6-9-2.7-9-6 4-6 9-6z'],
  ['parallelogram', '平行四辺形（入出力）', 'M7 6h14l-4 12H3z'],
  ['text', 'テキストのみ', 'M5 6h14M12 6v13'],
];

function renderSelbar({ nodes, edges }) {
  const bar = $('selbar');
  if (!nodes.length && !edges.length) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }
  bar.hidden = false;
  const items = [];
  if (nodes.length) {
    const ns = nodes.map((id) => doc.node(id)).filter(Boolean);
    const shape = ns.every((n) => n.shape === ns[0]?.shape) ? ns[0]?.shape : null;
    const color = ns.every((n) => n.color === ns[0]?.color) ? ns[0]?.color : null;
    for (const [s, title, d] of SHAPE_BUTTONS) {
      items.push(
        el('button', { class: `icon-btn${shape === s ? ' active' : ''}`, title, 'aria-label': title, onclick: () => updateNodes(nodes, { shape: s }) }, icon(d)),
      );
    }
    items.push(el('span', { class: 'divider' }));
    for (const c of COLORS) {
      items.push(el('button', { class: `swatch c-${c}${color === c ? ' active' : ''}`, title: colorName(c), 'aria-label': colorName(c), onclick: () => updateNodes(nodes, { color: c }) }));
    }
    items.push(el('span', { class: 'divider' }));
    if (nodes.length === 1) {
      items.push(el('button', { class: 'icon-btn', title: '文字を編集（Enter）', 'aria-label': '文字を編集', onclick: () => canvas.startEdit('node', nodes[0]) }, icon('M4 20h4L19 9l-4-4L4 16z')));
      items.push(el('button', { class: 'icon-btn', title: '下に次のノードを追加（Tab）', 'aria-label': '下に次のノードを追加', onclick: () => canvas.addConnected(nodes[0], 'bottom') }, icon('M12 4v12M7 11l5 5 5-5M6 20h12')));
    }
    items.push(el('button', { class: 'icon-btn', title: '複製（Ctrl+D）', 'aria-label': '複製', onclick: () => canvas.duplicateSelection() }, icon('M8 8h12v12H8zM4 16V4h12')));
  }
  if (edges.length) {
    if (nodes.length) items.push(el('span', { class: 'divider' }));
    const es = edges.map((id) => doc.edge(id)).filter(Boolean);
    const style = es.every((e) => e.style === es[0]?.style) ? es[0]?.style : null;
    const arrow = es.every((e) => e.arrow);
    items.push(el('button', { class: `icon-btn${style === 'orthogonal' ? ' active' : ''}`, title: 'カギ線', 'aria-label': 'カギ線', onclick: () => updateEdges(edges, { style: 'orthogonal' }) }, icon('M4 18h7V6h9')));
    items.push(el('button', { class: `icon-btn${style === 'straight' ? ' active' : ''}`, title: '直線', 'aria-label': '直線', onclick: () => updateEdges(edges, { style: 'straight' }) }, icon('M4 20L20 4')));
    items.push(el('button', { class: `icon-btn${arrow ? ' active' : ''}`, title: '矢印の表示', 'aria-label': '矢印の表示', onclick: () => updateEdges(edges, { arrow: !arrow }) }, icon('M4 12h15M14 7l5 5-5 5')));
    items.push(el('button', { class: 'icon-btn', title: '向きを反対にする', 'aria-label': '向きを反対にする', onclick: () => reverseEdges(edges) }, icon('M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4')));
    if (edges.length === 1) {
      items.push(el('button', { class: 'icon-btn', title: 'ラベルを編集', 'aria-label': 'ラベルを編集', onclick: () => canvas.startEdit('edge', edges[0]) }, icon('M4 20h4L19 9l-4-4L4 16z')));
    }
  }
  items.push(el('span', { class: 'divider' }));
  items.push(el('button', { class: 'icon-btn btn danger', title: '削除（Delete）', 'aria-label': '削除', onclick: () => canvas.deleteSelection() }, icon('M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3')));
  bar.replaceChildren(...items);
}

function colorName(c) {
  return { default: '標準', blue: '青', green: '緑', yellow: '黄', red: '赤', purple: '紫', gray: 'グレー' }[c] || c;
}

function updateNodes(ids, patch) {
  const tx = doc.tx();
  for (const id of ids) {
    const n = doc.node(id);
    if (!n) continue;
    const next = { ...n, ...patch };
    if (patch.shape === 'diamond' && n.shape !== 'diamond') next.h = Math.max(n.h, 80);
    tx.put('node', { id, ...patch, ...canvas.fitSize(next, n.text) });
  }
  tx.commit();
  renderSelbar({ nodes: [...canvas.selNodes], edges: [...canvas.selEdges] });
}

function updateEdges(ids, patch) {
  const tx = doc.tx();
  for (const id of ids) if (doc.edge(id)) tx.put('edge', { id, ...patch });
  tx.commit();
  renderSelbar({ nodes: [...canvas.selNodes], edges: [...canvas.selEdges] });
}

function reverseEdges(ids) {
  const tx = doc.tx();
  for (const id of ids) {
    const e = doc.edge(id);
    if (e) tx.put('edge', { id, from: e.to, to: e.from });
  }
  tx.commit();
}

// ---------- 書き出し・読み込み ----------
function exportBoard() {
  const data = {
    format: 'flowchart-board',
    version: 1,
    name: doc.board.name || boardName(doc.id),
    nodes: doc.nodes().map(({ u, c, ...n }) => n),
    edges: doc.edges().map(({ u, c, ...e }) => e),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `${data.name.replace(/[\\/:*?"<>|]/g, '_')}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importBoard(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.nodes)) throw new Error('format');
    const id = await createBoard(data.name ? `${data.name}（読み込み）` : file.name.replace(/\.json$/, ''));
    const tx = doc.tx();
    const idMap = new Map();
    for (const n of data.nodes) {
      const nid = isValidId(n.id) ? n.id : uid();
      idMap.set(n.id, nid);
      tx.put('node', { ...n, id: nid });
    }
    for (const e of data.edges || []) {
      if (idMap.has(e.from) && idMap.has(e.to)) tx.put('edge', { ...e, id: isValidId(e.id) ? e.id : uid(), from: idMap.get(e.from), to: idMap.get(e.to) });
    }
    if (doc.id === id) tx.commit({ history: false });
    canvas.fit();
    toast(`${data.nodes.length} 個のノードを読み込みました`);
  } catch {
    toast('読み込めないファイルです', { kind: 'error' });
  }
}

// ---------- UI ----------
function toggleSidebar(open) {
  const app = $('app');
  const isOpen = !app.classList.contains('sidebar-closed');
  const next = open ?? !isOpen;
  app.classList.toggle('sidebar-closed', !next);
  $('scrim').hidden = !(next && window.matchMedia('(max-width: 900px)').matches);
  localStorage.setItem('fc:sidebar', next ? '1' : '0');
  setTimeout(() => canvas.requestRender(), 220);
}

const TOOL_INFO = {
  select: { name: '選択', hint: 'ノードを動かす・つなぐ・編集する。ペンでなぞると範囲選択、指でドラッグすると画面の移動' },
  text: { name: '文字ペン', hint: '文字を書く（黒）。ノードの中に書くとそのノードの文字、線の近くに書くと線のラベルになります' },
  shape: { name: '図形ペン', hint: '四角・角丸・ひし形・丸・平行四辺形の枠と、つなぐ線を書く（青）' },
  eraser: { name: '消しゴム', hint: 'なぞった手書き・ノード・線を消します（最初に触れたものの種類だけ消えます）' },
};

let toolHintUntil = 0;

function setTool(tool) {
  canvas.setTool(tool);
}

/** ツールが変わったとき（ボタン・キー・ペンのサイドボタンのどれでも） */
function onToolChanged() {
  const tool = canvas.tool;
  document.querySelectorAll('[data-tool]').forEach((b) => {
    const on = b.dataset.tool === tool;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
  toolHintUntil = Date.now() + 4000;
  updateHint();
  setTimeout(updateHint, 4100);
}

// ---------- 元に戻す / やり直す（図の変更と手書きを、操作した順にまとめて扱う） ----------
const history = { undo: [], redo: [] };
let suppressDocHistory = false;

function pushHistory(entry) {
  history.undo.push(entry);
  if (history.undo.length > 300) history.undo.shift();
  history.redo = [];
  doc.redoStack = [];
  updateUndo();
}

function resetHistory() {
  history.undo = [];
  history.redo = [];
  updateUndo();
}

function updateUndo() {
  $('undoBtn').disabled = !history.undo.length;
  $('redoBtn').disabled = !history.redo.length;
}

function updateHint() {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  let hint = '';
  if (Date.now() < toolHintUntil) {
    const info = TOOL_INFO[canvas.tool];
    hint = `${info.name}: ${info.hint}`;
  } else if (canvas.ink.length) {
    hint = '書き終わったら「整形 OCR」を押すと、図形・矢印・文字に変換されます';
  } else if (!doc.nodes().length) {
    hint =
      canvas.tool === 'shape'
        ? '四角・ひし形・丸を描き、図形どうしを線でつないでみましょう'
        : canvas.tool === 'text'
          ? '図形の中や線の近くに文字を書いてみましょう'
          : coarse
            ? 'ダブルタップでノードを追加 ／ 文字ペン・図形ペンで手書き ／ 2本指で移動・拡大'
            : 'ダブルクリックでノードを追加 ／ ドラッグで移動 ／ Ctrl+ホイールで拡大';
  }
  $('hint').textContent = hint;
}

function bindUI() {
  $('menuBtn').addEventListener('click', () => toggleSidebar());
  $('scrim').addEventListener('click', () => toggleSidebar(false));
  $('newBoard').addEventListener('click', async () => {
    const name = await ask('新しいボードの名前', `ボード ${state.boards.length + 1}`, { okLabel: '作成' });
    if (name !== null) {
      await createBoard(name);
      if (window.matchMedia('(max-width: 900px)').matches) toggleSidebar(false);
    }
  });
  $('boardName').addEventListener('change', (e) => {
    const name = e.target.value.trim();
    if (name && state.currentId) applyRename(state.currentId, name);
    else e.target.value = boardName(state.currentId);
  });
  $('boardName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.target.blur();
  });
  document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('ocrBtn').addEventListener('click', () => runOCR('all'));
  $('ocrMenuBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('ocrMenu');
    if (!menu.hidden) return closeOcrMenu();
    const r = $('ocrMenuBtn').getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(r.right - 200, window.innerWidth - 208))}px`;
    menu.style.top = `${r.bottom + 6}px`;
    menu.hidden = false;
  });
  $('ocrMenu').addEventListener('click', (e) => {
    const mode = e.target.closest('[data-ocr]')?.dataset.ocr;
    if (mode) runOCR(mode);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#ocrMenu, #ocrMenuBtn')) closeOcrMenu();
  });
  $('clearInk').addEventListener('click', () => canvas.clearInk());
  $('addNode').addEventListener('click', () => {
    const r = canvas.rect();
    const at = canvas.toWorld({ x: r.width / 2, y: r.height / 2 });
    // 画面中央が埋まっていたら少しずらす
    for (let i = 0; i < 30 && canvas.nodeAt(at); i++) at.y += 90;
    canvas.addNodeAt(at);
  });
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  $('zoomIn').addEventListener('click', () => canvas.zoomBy(1.25));
  $('zoomOut').addEventListener('click', () => canvas.zoomBy(0.8));
  $('zoomLabel').addEventListener('click', () => {
    const r = canvas.rect();
    canvas.zoomAt({ x: r.width / 2, y: r.height / 2 }, 1 / canvas.view.k);
  });
  $('fitBtn').addEventListener('click', () => canvas.fit());
  $('exportBtn').addEventListener('click', exportBoard);
  $('status').addEventListener('click', openSyncDialog);
  $('syncBtn').addEventListener('click', openSyncDialog);
  $('syncForm').addEventListener('change', (e) => {
    if (e.target.name === 'mode') showModeFields();
  });
  $('syncForm').addEventListener('submit', async (e) => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    await saveSyncSetting();
  });
  $('importInput').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) importBoard(f);
    e.target.value = '';
  });

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement || t?.isContentEditable || document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    // サイドボタンを PageDown / PageUp キーとして送るペン（Redmi / Xiaomi のスマートペンなど）
    if ((e.key === 'PageDown' || e.key === 'PageUp') && !mod && (canvas.penSeen || window.matchMedia('(pointer: coarse)').matches)) {
      e.preventDefault();
      if (!e.repeat) canvas.onPenButton(e.key === 'PageDown' ? 'barrel' : 'aux');
      return;
    }
    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && key === 'y') {
      e.preventDefault();
      redo();
      return;
    }
    if (canvas.handleKey(e)) {
      e.preventDefault();
      return;
    }
    if (mod || e.altKey) return;
    if (key === 'v') setTool('select');
    else if (key === 't') setTool('text');
    else if (key === 'g') setTool('shape');
    else if (key === 'e') setTool('eraser');
    else if (key === 'p') setTool(canvas.tool === 'text' ? 'shape' : 'text');
    else if (key === 'f') canvas.fit();
    else if (key === '+' || key === '=') canvas.zoomBy(1.25);
    else if (key === '-') canvas.zoomBy(0.8);
    else if (key === 'r' && canvas.ink.length) runOCR(e.shiftKey ? 'shapes' : 'all');
  });

  canvas.addEventListener('selection', (e) => renderSelbar(e.detail));
  canvas.addEventListener('view', () => {
    $('zoomLabel').textContent = `${Math.round(canvas.view.k * 100)}%`;
    saveViewSoon();
  });
  canvas.addEventListener('ink', (e) => {
    const n = e.detail;
    $('inkCount').hidden = !n;
    $('inkCount').textContent = String(n);
    updateUndo();
    updateHint();
  });
  canvas.addEventListener('tool', onToolChanged);
  canvas.addEventListener('ink-history', (e) => pushHistory({ ink: e.detail }));
  // 消しゴムで消した手書きとノード・線は、1回の操作として元に戻す
  canvas.addEventListener('erase-history', (e) => {
    const { items, docChanges } = e.detail;
    if (docChanges.length) {
      suppressDocHistory = true;
      doc.pushHistory(docChanges);
      suppressDocHistory = false;
    }
    pushHistory({ doc: docChanges.length > 0, ink: items.length ? { type: 'erase', items } : null });
  });
  canvas.addEventListener('pen-button', (e) => {
    const d = e.detail;
    if (d.unknown !== undefined) toast(`ペンのボタン（${d.unknown}）には何も割り当てていません`);
    else toast(TOOL_INFO[d.tool].name + 'にしました');
  });
  doc.addEventListener('history', () => {
    if (!suppressDocHistory) pushHistory({ doc: true });
  });
  bindPenTest();
  $('penSwap').checked = localStorage.getItem('fc:penSwap') === '1';
  canvas.swapPenButtons = $('penSwap').checked;
  $('penSwap').addEventListener('change', (e) => {
    canvas.swapPenButtons = e.target.checked;
    localStorage.setItem('fc:penSwap', e.target.checked ? '1' : '0');
    toast(e.target.checked ? '1つ目のボタン: 消しゴム ／ 2つ目のボタン: ペンの切り替え' : '1つ目のボタン: ペンの切り替え ／ 2つ目のボタン: 消しゴム');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      saveView();
      saveCache.flush();
      sync?.flushNow();
    } else {
      sync?.reconnectNow();
    }
  });
  window.addEventListener('online', () => sync?.reconnectNow());
  window.addEventListener('pagehide', () => {
    saveView();
    sync?.flushNow();
  });
}

const saveViewSoon = debounce(saveView, 400);

function closeOcrMenu() {
  $('ocrMenu').hidden = true;
}

/** ペンのボタン確認: ブラウザに届いた pointer イベントの中身を表示する */
function bindPenTest() {
  const area = $('penTestArea');
  const log = $('penTestLog');
  const lines = [];
  const BUTTON_NAMES = { 0: 'ペン先/なし', 1: '2つ目（中）', 2: '1つ目（右）', 5: '消しゴム' };
  const describe = (e) => {
    const bits = [];
    if (e.buttons & 1) bits.push('ペン先');
    if (e.buttons & 2) bits.push('1つ目');
    if (e.buttons & 4) bits.push('2つ目');
    if (e.buttons & 32) bits.push('消しゴム');
    return `${e.type.replace('pointer', '')} 種類=${e.pointerType} button=${e.button}${BUTTON_NAMES[e.button] ? `(${BUTTON_NAMES[e.button]})` : ''} buttons=${e.buttons}[${bits.join('+') || 'なし'}] 筆圧=${e.pressure.toFixed(2)}`;
  };
  let lastButtons = -1;
  const onEvent = (e) => {
    e.preventDefault();
    // 動いているだけのイベントは、ボタンの状態が変わったときだけ記録する
    if (e.type === 'pointermove' && e.buttons === lastButtons) return;
    lastButtons = e.buttons;
    lines.unshift(describe(e));
    lines.length = Math.min(lines.length, 12);
    log.textContent = lines.join('\n');
    if (e.pointerType === 'pen' && (e.buttons & 2 || e.button === 2)) area.textContent = '1つ目のボタン: 届いています';
    else if (e.pointerType === 'pen' && (e.buttons & 4 || e.button === 1)) area.textContent = '2つ目のボタン: 届いています';
    else if (e.pointerType === 'pen' && (e.buttons & 32 || e.button === 5)) area.textContent = '消しゴム: 届いています';
  };
  for (const t of ['pointerdown', 'pointermove', 'pointerup']) area.addEventListener(t, onEvent);
  // ボタンをキーボードのキーとして送るペンもあるので、キーも記録する
  const onKey = (e) => {
    if (!$('penTestDialog').open) return;
    e.preventDefault();
    lines.unshift(`${e.type} key=${e.key} code=${e.code} keyCode=${e.keyCode}`);
    lines.length = Math.min(lines.length, 12);
    log.textContent = lines.join('\n');
    area.textContent = `キー「${e.key || e.code}」が届いています`;
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  area.addEventListener('auxclick', (e) => {
    lines.unshift(`auxclick button=${e.button}`);
    log.textContent = lines.join('\n');
  });
  area.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    lines.unshift('contextmenu（長押し・右クリック相当）');
    log.textContent = lines.join('\n');
  });
  $('penTestBtn').addEventListener('click', () => {
    lines.length = 0;
    log.textContent = '';
    area.textContent = 'ここでペンを使う';
    $('penTestDialog').showModal();
  });
}

function applyHistory(entry, dir) {
  if (entry.doc) {
    if (dir === 'undo') doc.undo();
    else doc.redo();
  }
  if (entry.ink) canvas.applyInkRecord(entry.ink, dir);
}

function undo() {
  canvas.finishEdit();
  const entry = history.undo.pop();
  if (entry) {
    applyHistory(entry, 'undo');
    history.redo.push(entry);
  }
  updateUndo();
}

function redo() {
  canvas.finishEdit();
  const entry = history.redo.pop();
  if (entry) {
    applyHistory(entry, 'redo');
    history.undo.push(entry);
  }
  updateUndo();
}

// ---------- 起動 ----------
async function main() {
  bindUI();
  if (localStorage.getItem('fc:sidebar') === '0' || window.matchMedia('(max-width: 900px)').matches) {
    $('app').classList.add('sidebar-closed');
  }
  setTool('select');
  sync = await createSync();
  await sync.init();
  sync.addEventListener('error', (e) => toast(e.detail, { kind: 'error', duration: 6000 }));
  sync.addEventListener('renamed', (e) => {
    const b = state.boards.find((x) => x.id === e.detail.id);
    if (b) b.name = e.detail.name;
    if (e.detail.id === state.currentId) $('boardName').value = e.detail.name;
    renderBoardList();
  });
  sync.addEventListener('open', (e) => uploadBoards(e.detail));
  sync.addEventListener('status', updateStatus);
  sync.addEventListener('pending', updateStatus);
  sync.addEventListener('boards', (e) => setBoards(e.detail));
  sync.addEventListener('board-deleted', (e) => onBoardDeleted(e.detail));
  sync.addEventListener('snapshot', (e) => {
    const snap = e.detail;
    if (snap.id !== doc.id) return;
    sync.flushNow();
    const keep = new Set(sync.pendingOps(snap.id).map((op) => `${op.k}:${op.id}`));
    doc.mergeSnapshot(snap, keep);
    const b = state.boards.find((x) => x.id === snap.id);
    if (b && snap.name && b.name !== snap.name) {
      b.name = snap.name;
      renderBoardList();
    }
    if (snap.name) $('boardName').value = snap.name;
    saveCache();
    updateHint();
  });
  sync.addEventListener('ops', (e) => doc.applyRemote(e.detail));

  doc.addEventListener('change', (e) => {
    const { ops, local } = e.detail;
    if (local && ops.length) sync.send(doc.id, ops);
    if (ops.length) touchBoardEntry();
    saveCache();
    updateUndo();
    if (!e.detail.reset) updateHint();
    if (canvas.selNodes.size || canvas.selEdges.size) {
      if (!canvas.action) renderSelbar({ nodes: [...canvas.selNodes], edges: [...canvas.selEdges] });
    }
  });

  state.boards = (await idbGet('boards')) || [];
  setBoards(state.boards.filter((b) => !b.local));
  sync.connect();

  // 最初に開くボード: 前回のボード → 一覧の先頭 → サーバーの一覧を待つ → 新規作成
  const last = localStorage.getItem('fc:lastBoard');
  let target = state.boards.find((b) => b.id === last)?.id || (last && (await idbGet(`board:${last}`)) ? last : null);
  if (!target && state.boards.length) target = state.boards[0].id;
  if (!target && sync.enabled) {
    const list = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 10000);
      sync.addEventListener(
        'boards',
        (e) => {
          clearTimeout(timer);
          resolve(e.detail);
        },
        { once: true },
      );
    });
    target = list?.[0]?.id;
  }
  if (target) await openBoard(target);
  else await createBoard('はじめてのボード');

  $('appVersion').textContent = `バージョン ${APP_VERSION}`;
  if ('serviceWorker' in navigator && window.isSecureContext) {
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
    // 新しい版が入ったら、作業中でなければ読み込み直して切り替える
    navigator.serviceWorker.addEventListener('controllerchange', async () => {
      if (!hadController) return;
      if (!canvas.ink.length && !canvas.editing && !canvas.action) {
        await idbSet(`board:${doc.id}`, doc.board);
        await sync.stop();
        location.reload();
      } else {
        toast('新しい版があります。書き終わったら、アプリを開き直してください', { duration: 6000 });
      }
    });
  }
}

main();

// テストやデバッグ用
window.__flow = { doc, canvas, get sync() { return sync; }, state, runOCR };
