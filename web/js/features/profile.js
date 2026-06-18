/**
 * features/profile.js
 * Nostr profile (NIP-01 kind-0 metadata) — fetch, cache, verify NIP-05,
 * edit and publish.
 *
 * Cached profile lives in the IndexedDB meta store keyed by pubkey, so it
 * survives reloads and works offline. Display name / about / picture /
 * nip05 are the standard kind-0 fields. NIP-05 is verified via the
 * .well-known/nostr.json HTTPS endpoint.
 */

import { store } from '../core/store.js';
import { bus } from '../core/eventbus.js';
import { account } from './account.js';
import { relays } from './relays.js';
import { npubToPk, toHex } from '../core/nostr.js';

const KIND_PROFILE = 0;
const NIP05_TTL_MS = 5 * 60 * 1000;   // cache verification result for 5 min

// In-memory cache (mirrors the IndexedDB meta copy for synchronous reads).
let _cache = null;       // { name, displayName, about, picture, nip05, website, nip05Verified, fetchedAt, sourceEventId, dirty }
let _pubkeyHex = null;
let _wired = false;

/* ---------- helpers ---------- */

function metaKey(pub) { return 'profile:' + pub; }

async function resolvePubkeyHex() {
  const acc = account.current();
  if (!acc) return null;
  if (acc.rawPubkey) return acc.rawPubkey;
  if (acc.npub) {
    try { return toHex(npubToPk(acc.npub)); } catch { return null; }
  }
  return null;
}

/* ---------- caching ---------- */

async function loadCache(pub) {
  const raw = await store.getMeta(metaKey(pub));
  _cache = raw || null;
}

async function persist() {
  if (!_pubkeyHex || !_cache) return;
  await store.setMeta(metaKey(_pubkeyHex), _cache);
}

/* ---------- bus wiring ---------- */

function wire() {
  if (_wired) return;
  _wired = true;
  bus.on('account:changed', async () => {
    const acc = account.current();
    if (!acc) { _cache = null; _pubkeyHex = null; bus.emit('profile:changed'); return; }
    const pub = await resolvePubkeyHex();
    _pubkeyHex = pub;
    if (pub) { await loadCache(pub); bus.emit('profile:changed'); profile.load(); }
  });
}

/* ---------- public API ---------- */

export const profile = {
  /** Called once at boot. Subscribes to account changes + loads if connected. */
  async init() {
    wire();
    const pub = await resolvePubkeyHex();
    if (pub) {
      _pubkeyHex = pub;
      await loadCache(pub);
      bus.emit('profile:changed');
      this.load();   // best-effort refresh from relays
    }
  },

  /** Synchronous access to the cached profile. Returns null if none. */
  current() { return _cache; },

  /**
   * Fetch the newest kind-0 event for our pubkey from the read-relays and
   * merge it into the cache. Best-effort: silent on failure (keeps the
   * existing offline copy). Emits `profile:changed` when updated.
   */
  async load() {
    if (!_pubkeyHex) return;
    const relayUrl = relays.all().find(r => r.read)?.url;
    if (!relayUrl) return;

    const ev = await fetchNewestKind0(relayUrl, _pubkeyHex);
    if (!ev) return;

    let meta;
    try { meta = JSON.parse(ev.content); }
    catch { return; }   // malformed content — ignore

    // Only accept if newer than what we have.
    const cur = _cache || {};
    const remoteTs = ev.created_at || 0;
    const localTs = cur.sourceCreatedAt || 0;
    if (remoteTs < localTs) return;

    _cache = {
      name: meta.name || meta.display_name || '',
      displayName: meta.display_name || meta.name || '',
      about: meta.about || '',
      picture: meta.picture || '',
      nip05: meta.nip05 || '',
      website: meta.website || '',
      nip05Verified: cur.nip05Verified || false,
      fetchedAt: Date.now(),
      sourceEventId: ev.id,
      sourceCreatedAt: remoteTs,
      dirty: false,
    };
    // Mirror into the account record so the sidebar/labels pick it up.
    account.setProfile({ name: _cache.name, displayName: _cache.displayName });
    await persist();
    bus.emit('profile:changed');

    // Verify NIP-05 asynchronously (non-blocking).
    if (_cache.nip05) this.verifyNip05(_cache.nip05, _pubkeyHex).then(() => {
      bus.emit('profile:changed');
    });
  },

  /**
   * Local edit (does not publish). Merges a patch into the cache, marks it
   * dirty, persists, and emits `profile:changed`.
   */
  async update(patch) {
    const base = _cache || {
      name: '', displayName: '', about: '', picture: '', nip05: '', website: '',
      nip05Verified: false, fetchedAt: 0, sourceEventId: null, sourceCreatedAt: 0, dirty: false,
    };
    _cache = { ...base, ...patch, dirty: true };
    account.setProfile({ name: _cache.name, displayName: _cache.displayName });
    await persist();
    bus.emit('profile:changed');
  },

  /**
   * Publish the cached profile as a signed kind-0 event to all write-relays.
   * Requires a signing-capable account (nsec or NIP-07). Returns true on success.
   */
  async publish() {
    if (!_cache || !_pubkeyHex) throw new Error('profile: nothing to publish');
    const acc = account.current();
    if (!acc) throw new Error('profile: not connected');
    if (acc.source === 'npub') throw new Error('profile: read-only account cannot sign');

    const content = JSON.stringify({
      name: _cache.name || '',
      display_name: _cache.displayName || _cache.name || '',
      about: _cache.about || '',
      picture: _cache.picture || '',
      nip05: _cache.nip05 || '',
      website: _cache.website || '',
    });

    const unsigned = {
      kind: KIND_PROFILE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content,
    };

    const signed = await account.signEvent(unsigned);
    const msg = JSON.stringify(['EVENT', signed]);

    // Publish to all write-relays. Prefer the sync pool when open; otherwise
    // open a short-lived socket per relay.
    let sent = 0;
    const writeRelays = relays.all().filter(r => r.write);
    for (const r of writeRelays) {
      try { if (await sendViaPoolOrSocket(r.url, msg)) sent++; } catch {}
    }

    if (sent > 0) {
      _cache = { ..._cache, dirty: false, sourceEventId: signed.id, sourceCreatedAt: unsigned.created_at, fetchedAt: Date.now() };
      await persist();
      bus.emit('profile:changed');
      return true;
    }
    return false;
  },

  /**
   * Verify a NIP-05 handle against its .well-known/nostr.json endpoint.
   * Caches the boolean result for NIP05_TTL_MS. Updates the cache + persists.
   */
  async verifyNip05(nip05, pubkeyHex) {
    if (!nip05 || !pubkeyHex) return false;
    // Use cached verdict if fresh.
    if (_cache && _cache._nip05CheckedAt && (Date.now() - _cache._nip05CheckedAt < NIP05_TTL_MS)
        && _cache._nip05CheckedHandle === nip05) {
      return _cache.nip05Verified;
    }
    const at = nip05.indexOf('@');
    const local = at >= 0 ? nip05.slice(0, at) : '_';
    const domain = at >= 0 ? nip05.slice(at + 1) : nip05;
    const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(local)}`;
    let ok = false;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        ok = (data.names && data.names[local] && data.names[local].toLowerCase() === pubkeyHex.toLowerCase());
      }
    } catch { ok = false; }   // offline / CORS / DNS — treat as unverified, don't block
    if (_cache) {
      _cache.nip05Verified = ok;
      _cache._nip05CheckedAt = Date.now();
      _cache._nip05CheckedHandle = nip05;
      await persist();
    }
    return ok;
  },
};

/* ---------- relay helpers ---------- */

/** Fetch the newest kind-0 event for a pubkey from a single relay. */
function fetchNewestKind0(url, pubkeyHex) {
  return new Promise((resolve) => {
    let ws;
    let settled = false;
    const done = (val) => { if (settled) return; settled = true; try { ws?.close(); } catch {} resolve(val); };
    const timer = setTimeout(() => done(null), 6000);
    try { ws = new WebSocket(url); }
    catch { clearTimeout(timer); return done(null); }
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify(['REQ', 'profile-' + Math.random().toString(36).slice(2, 8),
          { kinds: [KIND_PROFILE], authors: [pubkeyHex], limit: 1 }]));
      } catch {}
    };
    let best = null;
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (!Array.isArray(msg)) return;
      if (msg[0] === 'EVENT' && msg[2] && msg[2].kind === KIND_PROFILE) {
        if (!best || (msg[2].created_at || 0) > (best.created_at || 0)) best = msg[2];
      } else if (msg[0] === 'EOSE') {
        clearTimeout(timer);
        done(best);
      }
    };
    ws.onerror = () => { clearTimeout(timer); done(null); };
  });
}

/** Send a message to a relay, reusing the sync pool's open socket if possible. */
async function sendViaPoolOrSocket(url, msg) {
  // Try the sync pool first (avoids opening a redundant socket).
  try {
    const { sync } = await import('../core/sync.js');
    const ws = sync.socket(url);
    if (ws && ws.readyState === WebSocket.OPEN) { ws.send(msg); return true; }
  } catch {}
  // Fall back to a one-shot socket.
  return new Promise((resolve) => {
    let ws;
    const timer = setTimeout(() => { try { ws?.close(); } catch {} resolve(false); }, 5000);
    try { ws = new WebSocket(url); }
    catch { clearTimeout(timer); return resolve(false); }
    ws.onopen = () => { try { ws.send(msg); } catch {} clearTimeout(timer); try { ws.close(); } catch {} resolve(true); };
    ws.onerror = () => { clearTimeout(timer); resolve(false); };
  });
}
