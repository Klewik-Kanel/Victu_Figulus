/**
 * sw.js - offline shell.
 *
 * Cache-first for the app and its data, because a kitchen is exactly where
 * you lose signal. Bump VERSION when you change any cached file, or the old
 * copy keeps being served.
 */
const VERSION = 'victu-v3';
const ASSETS = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/core.js',
  'js/store.js',
  'js/lookup.js',
  'data/foods.json',
  'data/portions.json',
  'data/seasonality.json',
  'data/recipes.json',
  'data/packaged.json',
  'manifest.webmanifest',
  'icon.svg',
  'assets/icons.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // Let fonts go to the network.

  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) {
        // Refresh in the background so edits land on the next open.
        fetch(e.request)
          .then((res) => res.ok && caches.open(VERSION).then((c) => c.put(e.request, res.clone())))
          .catch(() => {});
        return hit;
      }
      return fetch(e.request).catch(() => caches.match('index.html'));
    })
  );
});
