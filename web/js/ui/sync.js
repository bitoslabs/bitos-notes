/**
 * ui/sync.js
 * Sync status indicator (SRP: render a status chip from sync:status events).
 * Shows offline / syncing / synced + pending count, with a "sync now" tap.
 */

import { bus } from '../core/eventbus.js';
import { sync } from '../core/sync.js';
import { i18n } from '../core/i18n.js';

const $ = (id) => document.getElementById(id);

let _el = null;

function describe(status) {
  // status: { state: 'offline'|'syncing'|'synced'|'error', lastSyncAt, pending }
  const s = status || {};
  switch (s.state) {
    case 'offline':
      return { dot: 'offline', title: i18n.t('sync.offline'), icon: 'offline' };
    case 'syncing':
      return { dot: 'syncing', title: i18n.t('sync.syncing'), icon: 'syncing' };
    case 'error':
      return { dot: 'error', title: i18n.t('sync.error'), icon: 'error' };
    case 'synced':
    default: {
      if (s.pending > 0) {
        return { dot: 'syncing', title: i18n.t('sync.pending', { n: s.pending }), icon: 'syncing' };
      }
      const when = s.lastSyncAt ? relTime(s.lastSyncAt) : '';
      return { dot: 'synced', title: when ? `${i18n.t('sync.synced')} · ${when}` : i18n.t('sync.synced'), icon: 'synced' };
    }
  }
}

function relTime(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return i18n.t('sync.justNow') || 'now';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

const ICONS = {
  offline: '<svg viewBox="0 0 24 24" class="ico"><path d="M1 1l22 22"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.22-2.45"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="0.5"/></svg>',
  syncing: '<svg viewBox="0 0 24 24" class="ico spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
  synced:  '<svg viewBox="0 0 24 24" class="ico"><path d="M20 6L9 17l-5-5"/></svg>',
  error:   '<svg viewBox="0 0 24 24" class="ico"><path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="10"/></svg>',
};

function render(status) {
  if (!_el) return;
  const d = describe(status);
  _el.innerHTML = ICONS[d.icon] || ICONS.offline;
  _el.title = d.title;
  _el.setAttribute('aria-label', d.title);
  _el.dataset.state = d.dot;
}

export const syncStatus = {
  init() {
    _el = $('sync-status');
    if (!_el) return;
    _el.addEventListener('click', () => sync.now());
    bus.on('sync:status', (s) => render(s));
    // Initial render from current state.
    render(sync.status());
  },
  render,
};
