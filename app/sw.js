// 離線快取：頁面本身「網路優先」（確保拿到最新版），圖示等靜態檔快取優先；後端資料一律走網路。
const CACHE = 'aq-v5';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const ks = await caches.keys();
    const hadOld = ks.some((k) => k !== CACHE);
    await Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    // 從舊版升級時，把已開著的頁面重新載入成新版（避免卡在快取裡的舊版）
    if (hadOld) (await self.clients.matchAll({ type: 'window' })).forEach((c) => c.navigate(c.url).catch(() => {}));
  })());
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  const isPage = e.request.mode === 'navigate' || u.pathname.endsWith('.html') || u.pathname.endsWith('/');
  e.respondWith(caches.open(CACHE).then(async (c) => {
    if (isPage) {
      try { const r = await fetch(e.request); if (r.ok) c.put(e.request, r.clone()); return r; }
      catch (_) { return (await c.match(e.request)) || (await c.match('index.html')); }
    }
    const hit = await c.match(e.request);
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
