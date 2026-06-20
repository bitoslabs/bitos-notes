/**
 * sw.js — Service Worker for bitos Notes
 * Strategy: cache-first for the app shell (instant loads, works offline),
 * network-first for everything else. Notes data lives in localStorage, so the
 * app is fully functional offline once cached.
 */

const VERSION = 'v12';
const CACHE = `bitos-notes-${VERSION}`;

// App shell — everything needed to boot offline.
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/core/eventbus.js',
  './js/core/store.js',
  './js/core/db.js',
  './js/core/nostr.js',
  './js/core/nip44.js',
  './js/core/sync.js',
  './js/core/i18n.js',
  './js/core/theme.js',
  './js/core/router.js',
  './js/features/folders.js',
  './js/features/notes.js',
  './js/features/editor.js',
  './js/features/draw.js',
  './js/features/relays.js',
  './js/features/profile.js',
  './js/features/account.js',
  './js/ui/sidebar.js',
  './js/ui/notelist.js',
  './js/ui/settings.js',
  './js/ui/account.js',
  './js/ui/dialog.js',
  './js/ui/popup.js',
  './js/ui/sync.js',
  './js/ui/layout.js',
  './locales/en.js',
  './locales/fr.js',
  './locales/es.js',
  './locales/ar.js',
  './locales/th.js',
  './locales/lo.js',
  './icon.svg',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isNavigation = req.mode === 'navigate' || req.destination === 'document';
  const isShellDoc = url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/sw.js' || url.pathname === '/manifest.webmanifest';

  // Always try the network first for the HTML shell and SW-related files so
  // updates can break out of an old cached boot path.
  if (isNavigation || isShellDoc) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // Same-origin: cache-first for static assets, fall back to network + cache.
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then((cached) =>
        cached || fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        }).catch(() => cached)
      )
    );
    return;
  }

  // Cross-origin (e.g. Nostr relays via WS, or CDNs): try network, fall back.
  e.respondWith(fetch(req).catch(() => caches.match(req)));
});
