// IndexedDB の簡易ラッパー（端末内キャッシュ用）。使えない環境ではメモリに保存する。
const DB_NAME = 'flowchart';
const STORE = 'kv';
let dbPromise = null;
const memory = new Map();

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

async function run(mode, fn) {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export async function idbGet(key) {
  const v = await run('readonly', (s) => s.get(key));
  return v === undefined ? memory.get(key) : v;
}

export async function idbSet(key, value) {
  memory.set(key, value);
  await run('readwrite', (s) => s.put(value, key));
}

export async function idbDel(key) {
  memory.delete(key);
  await run('readwrite', (s) => s.delete(key));
}
