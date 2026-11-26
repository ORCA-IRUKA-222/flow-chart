// オフラインでもアプリを開けるようにするサービスワーカー（https または localhost のときだけ動く）
const CACHE = 'flowchart-v2';
// sw.js からの相対パス（PC のサーバーでも GitHub Pages のサブフォルダでも動くように）
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icon.svg',
  'js/app.js',
  'js/canvas.js',
  'js/config.js',
  'js/doc.js',
  'js/geometry.js',
  'js/handwriting.js',
  'js/idb.js',
  'js/recognize.js',
  'js/sync.js',
  'js/util.js',
  'shared/ops.js',
].map((p) => new URL(p, self.registration.scope).href);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// まずネットワーク（3秒で諦める）、つながらなければキャッシュ
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  e.respondWith(networkFirst(e.request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    if (request.mode === 'navigate') {
      const index = await cache.match(new URL('index.html', self.registration.scope).href);
      if (index) return index;
    }
    return Response.error();
  }
}
