// Cache-first service worker: the whole app works without a network.
importScripts('version.js'); // self.BP_LOG_VERSION; a new version means a new cache
const CACHE = 'bp-log-' + self.BP_LOG_VERSION.version;
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'version.js', 'ocr.js', 'digitnet.js', 'digitnet-weights.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache, so a new version never stores old files
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // test pages and fixtures always come from the network (never a stale cached copy)
  const url = new URL(e.request.url);
  if (url.pathname.includes('/test/')) return;
  // the About page's update check asks the network directly
  if (url.searchParams.has('fresh')) return;
  // stale-while-revalidate: answer from cache instantly, refresh it in the background
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then((res) => {
      if (res.ok && new URL(e.request.url).origin === location.origin) cache.put(e.request, res.clone());
      return res;
    }).catch(() => hit);
    return hit || fresh;
  }));
});
