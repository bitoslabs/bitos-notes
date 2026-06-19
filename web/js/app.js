/**
 * app.js — entry point / bootstrap
 * The ONLY job of this file is to initialise modules in the right order and
 * wire cross-module events. No business logic lives here.
 */

import { i18n } from './core/i18n.js';
import { theme } from './core/theme.js';
import { router } from './core/router.js';
import { store } from './core/store.js';
import { sync } from './core/sync.js';
import { account } from './features/account.js';
import { profile } from './features/profile.js';
import { editor } from './features/editor.js';
import { draw } from './features/draw.js';
import { sidebar } from './ui/sidebar.js';
import { noteList } from './ui/notelist.js';
import { settings } from './ui/settings.js';
import { accountModal } from './ui/account.js';
import { syncStatus } from './ui/sync.js';
import { bus } from './core/eventbus.js';

async function boot() {
  // 1. Theme first (avoid flash of wrong colors).
  theme.init();

  // 2. i18n (synchronous: locales are static ES imports).
  i18n.setLocale(i18n.detect());

  // 3. Hydrate IndexedDB-backed caches (notes + folders) before any read.
  //    Migrates legacy localStorage data on the first run.
  try { await store.init(); } catch (e) { console.error('[boot] store.init failed', e); }

  // 4. Core infrastructure.
  router.init();

  // 5. UI modules (register DOM handlers).
  sidebar.init();
  sidebar.renderAccount();
  noteList.init();
  editor.init();
  draw.init();
  settings.init();
  accountModal.init();
  syncStatus.init();

  // 6. Initial render.
  sidebar.render();
  noteList.render();
  renderAbout();

  // 7. Wire cross-module events (kept here so modules stay decoupled).
  wireEvents();

  // 8. Start Nostr sync (no-op if no account; connects to relays otherwise).
  try { sync.init(); } catch (e) { console.error('[boot] sync.init failed', e); }

  // 8b. Load Nostr profile (best-effort; no-op if no account).
  try { profile.init(); } catch (e) { console.error('[boot] profile.init failed', e); }

  // 9. Restore last-opened note (desktop nicety).
  restoreSession();

  // 10. PWA: register service worker for offline.
  registerSW();
}

function wireEvents() {
  // Note opened → load it into the editor + navigate on mobile.
  bus.on('note:selected', (n) => {
    if (n) { editor.load(n); router.go('editor'); }
    else   { editor.clear(); }
  });

  // Folder changed → clear editor selection + navigate to list on mobile.
  bus.on('folder:selected', () => {
    router.go(router.mode === 'mobile' ? 'list' : router.view);
    editor.clear();
  });

  // Mobile back buttons.
  document.getElementById('back-folders').addEventListener('click', () => router.go('folders'));
  document.getElementById('back-notes').addEventListener('click',   () => router.go('list'));

  // Toast handler (any module can emit 'toast').
  const toast = document.getElementById('toast');
  let toastTimer;
  bus.on('toast', (msg) => {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2400);
  });

  // Account changes → refresh sidebar + settings.
  bus.on('account:changed', () => {
    sidebar.renderAccount();
    settings.renderAccount();
  });
}

function restoreSession() {
  // On desktop, reopen the last note (if it still exists) for a warm welcome.
  if (router.mode === 'desktop') {
    const { lastNote } = store.getPrefs();
    if (lastNote) {
      import('./features/notes.js').then(({ notes }) => {
        if (notes.find(lastNote)) noteList.select(lastNote);
      });
    }
  }
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  // Skip the service worker on local dev origins so the browser always hits
  // the live filesystem (no stale cached assets while iterating). Production
  // origins still get the full offline cache.
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return;
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

/** Populate the About section with the app version + build label. */
function renderAbout() {
  const VERSION = 'v0.2';
  const BUILD = '2026.06';
  const ver = document.getElementById('about-version');
  const build = document.getElementById('about-build');
  if (ver) ver.textContent = VERSION;
  if (build) build.textContent = `BitOS Notes ${VERSION} · ${BUILD}`;
}

boot();
