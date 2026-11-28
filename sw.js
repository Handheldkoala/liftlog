// Network first, so new versions arrive when online; cached copy keeps the app working offline in the gym.
const V = 'liftlog-v3.4';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'data.js', 'sync.js', 'analyze.js', 'social.js', 'vbt.js', 'rpe.js', 'icons.js', 'manifest.json', 'icons/icon-180.png', 'icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
