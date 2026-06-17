/**
 * app.js — entry point / bootstrap
 * The ONLY job of this file is to initialise modules in the right order and
 * wire cross-module events. No business logic lives here.
 */

import { i18n } from './core/i18n.js';
import { theme } from './core/theme.js';
import { router } from './core/router.js';
import { editor } from './features/editor.js';
import { sidebar } from './ui/sidebar.js';
import { noteList } from './ui/notelist.js';
import { settings } from './ui/settings.js';
import { bus } from './core/eventbus.js';

async function boot() {
  // 1. Theme first (avoid flash of wrong colors).
  theme.init();

  // 2. i18n (synchronous: locales are static ES imports).
  i18n.setLocale(i18n.detect());

  // 3. Core infrastructure.
  router.init();

  // 4. UI modules (register DOM handlers).
  sidebar.init();
  noteList.init();
  editor.init();
  settings.init();

  // 5. Initial render.
  sidebar.render();
  noteList.render();

  // 6. Wire cross-module events (kept here so modules stay decoupled).
  wireEvents();

  // 7. Restore last-opened note (desktop nicety).
  restoreSession();

  // 8. PWA: register service worker for offline.
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
}

function restoreSession() {
  // On desktop, reopen the last note (if it still exists) for a warm welcome.
  if (router.mode === 'desktop') {
    import('./core/store.js').then(({ store }) => {
      const { lastNote } = store.getPrefs();
      // editor.currentId is checked implicitly via noteList.select
      if (lastNote) {
        import('./features/notes.js').then(({ notes }) => {
          if (notes.find(lastNote)) noteList.select(lastNote);
        });
      }
    });
  }
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot();
