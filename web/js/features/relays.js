/**
 * features/relays.js
 * Nostr relay manager (SRP: relay CRUD + flags + connectivity test).
 *
 * A relay record: { url, read, write, status, latency }
 *   status: 'unknown' | 'checking' | 'ok' | 'fail'
 *
 * Connectivity test opens a real WebSocket, sends NIP-01 REQ, and measures RTT.
 * No actual note sync happens here — that's a future sync engine's job. This
 * module only manages the *list* and *health* of relays.
 */

import { store } from '../core/store.js';
import { bus } from '../core/eventbus.js';

const DEFAULTS = [
  { url: 'wss://relay.damus.io',  read: true, write: true,  status: 'unknown', latency: null },
  { url: 'wss://nos.lol',         read: true, write: true,  status: 'unknown', latency: null },
  { url: 'wss://relay.nostr.band',read: true, write: false, status: 'unknown', latency: null },
];

const URL_RE = /^wss?:\/\/[^\s/]+(:\d+)?(\/[^\s]*)?$/i;

export const relays = {
  /** All relays, seeded with defaults on first run. */
  all() {
    const list = store.getRelays();
    if (list.length === 0) {
      store.setRelays(DEFAULTS);
      return [...DEFAULTS];
    }
    return list;
  },

  /** Validation: returns an error key (i18n) or null if valid. */
  validate(url, existing = []) {
    if (!URL_RE.test(url.trim())) return 'relays.invalid';
    const normalized = url.trim().replace(/\/+$/, '');
    if (existing.some(r => r.url === normalized)) return 'relays.duplicate';
    return null;
  },

  /** Add a relay. Returns {ok, error, relay}. */
  add(url) {
    const list = this.all();
    const err = this.validate(url, list);
    if (err) return { ok: false, error: err };
    const relay = { url: url.trim().replace(/\/+$/, ''), read: true, write: true, status: 'unknown', latency: null };
    store.setRelays([...list, relay]);
    bus.emit('relays:changed');
    return { ok: true, relay };
  },

  /** Remove a relay by URL. */
  remove(url) {
    store.setRelays(this.all().filter(r => r.url !== url));
    bus.emit('relays:changed');
  },

  /** Toggle the read/write flag on a relay. */
  toggleFlag(url, flag) {
    if (flag !== 'read' && flag !== 'write') return;
    const list = this.all().map(r => r.url === url ? { ...r, [flag]: !r[flag] } : r);
    store.setRelays(list);
    bus.emit('relays:changed');
  },

  /** Test one relay: open WS, send a minimal REQ, time first message. */
  async test(url) {
    this._setStatus(url, 'checking');
    bus.emit('relays:changed');

    return new Promise((resolve) => {
      const start = performance.now();
      let ws;
      const done = (status, latency) => {
        try { ws?.close(); } catch {}
        this._setStatus(url, status, latency);
        bus.emit('relays:changed');
        resolve({ url, status, latency });
      };
      const timer = setTimeout(() => done('fail', null), 8000);

      try {
        ws = new WebSocket(url);
      } catch {
        clearTimeout(timer); return done('fail', null);
      }
      ws.onopen = () => {
        // NIP-01: ["REQ", subId, {kinds:[1], limit:1}]
        ws.send(JSON.stringify(['REQ', 'health-' + Date.now(), { kinds: [1], limit: 1 }]));
      };
      ws.onmessage = () => {
        clearTimeout(timer);
        done('ok', Math.round(performance.now() - start));
      };
      ws.onerror = () => { clearTimeout(timer); done('fail', null); };
    });
  },

  /** Test every relay in parallel. */
  async testAll() {
    const urls = this.all().map(r => r.url);
    return Promise.all(urls.map(u => this.test(u)));
  },

  _setStatus(url, status, latency = null) {
    const list = this.all().map(r => r.url === url ? { ...r, status, latency } : r);
    store.setRelays(list);
  },
};
