// 离线外壳。同源子资源一律**网络优先、失败退缓存**：手工 VERSION 号配 cache-first 会把
// js/css 永久钉死在旧版，出新 HTML 配旧 JS 的鬼状态（本组踩过）。版本号只用来在 activate
// 时清掉上一代的缓存，不用来决定读不读网络。
const VERSION = 'loshu-v1.0.0';

// 只预取外壳；图标与纹理交给网络优先那条路，省得首屏排队抓 14 张 PNG。
const SHELL = [
  './',
  './index.html',
  './css/game.css',
  './js/main.js',
  './js/theme.js',
  './js/store.js',
  './js/ui/game.js',
  './js/render/board.js',
  './js/audio/synth.js',
  './js/engine/rng.js',
  './js/engine/loshu.js',
  './js/engine/count.js',
  './js/engine/generate.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(VERSION)
      .then((cache) => Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })))))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    ev.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }
  ev.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && (res.type === 'basic' || res.type === 'default')) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
