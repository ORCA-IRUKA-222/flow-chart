// 同期先サーバーの設定。
//
//   localStorage 'fc:server'
//     なし（未設定） … アプリを配信しているサーバーが同期サーバーなら、それを使う（自動）
//     ''            … 同期しない（この端末だけで使う）
//     'https://…'   … 指定したサーバーと同期する
//
// アプリを GitHub Pages などから開いた場合、同じ場所に同期サーバーはないので
// 「この端末だけ」で動き、同期先を設定するとそこへ送る。

const KEY = 'fc:server';
const SYNC_KEY = 'fc:sync';
const GH_TOKEN_KEY = 'fc:ghToken';

/**
 * 同期の方式。
 *   { mode: 'local' }                     この端末だけ
 *   { mode: 'github', repo: 'owner/name' } GitHub のリポジトリに保存（トークンは別に保存）
 *   { mode: 'server', server: 'https://…' } 自分の同期サーバー
 *   null                                   未設定（アプリを配信しているサーバーがあれば自動でそこ）
 */
export function getSyncConfig() {
  try {
    const v = JSON.parse(localStorage.getItem(SYNC_KEY));
    return v && typeof v.mode === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function setSyncConfig(cfg) {
  localStorage.setItem(SYNC_KEY, JSON.stringify(cfg));
  localStorage.removeItem(KEY);
}

export function githubToken() {
  return localStorage.getItem(GH_TOKEN_KEY) || '';
}

export function setGithubToken(token) {
  if (token) localStorage.setItem(GH_TOKEN_KEY, token);
  else localStorage.removeItem(GH_TOKEN_KEY);
}

/** テスト用に GitHub API の場所を差し替えられる */
export function githubApi() {
  return localStorage.getItem('fc:ghApi') || 'https://api.github.com';
}

export function normalizeRepo(value) {
  const s = String(value || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  return /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(s) ? s : null;
}
const AUTO_KEY = 'fc:serverAuto';

export function normalizeServer(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  const withProto = /^https?:\/\//i.test(s) ? s : `${location.protocol === 'https:' ? 'https' : 'http'}://${s}`;
  const u = new URL(withProto);
  return u.origin;
}

export function serverSetting() {
  return localStorage.getItem(KEY);
}

export function setServerSetting(value) {
  if (value === null) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, value);
}

/** 実際に使う同期先の origin（同期しない場合は null） */
export async function resolveServer() {
  const s = serverSetting();
  if (s === '') return null;
  if (s) return s;
  // 自動: このページを配信しているサーバーに同期 API があるか確かめる
  try {
    const res = await fetch('/api/config', { signal: AbortSignal.timeout(4000), cache: 'no-store' });
    const json = res.ok ? await res.json() : null;
    const found = json && typeof json.auth === 'boolean';
    localStorage.setItem(AUTO_KEY, found ? 'yes' : 'no');
    return found ? location.origin : null;
  } catch {
    // 通信できない（オフライン）。前回確かめた結果を使う
    return localStorage.getItem(AUTO_KEY) === 'yes' ? location.origin : null;
  }
}

/** https のページから http のサーバーへは、ブラウザの制限で接続できない */
export function isBlockedMixedContent(origin) {
  return location.protocol === 'https:' && origin.startsWith('http:') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin);
}

export function apiUrl(origin, path) {
  return `${origin}${path}`;
}

export function wsUrl(origin, token) {
  const u = new URL(origin);
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${u.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}
