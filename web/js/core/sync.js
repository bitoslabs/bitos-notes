/**
 * core/sync.js
 * Nostr sync engine — keeps notes + folders in sync across devices.
 *
 * Model (per the project plan):
 *   - Each note/folder is a kind:30078 parameterized-replaceable event.
 *     d-tag = item id, content = NIP-44-encrypted JSON of the item fields.
 *   - Hard-delete → NIP-09 kind:5 deletion referencing the last published event id.
 *   - Conflict resolution: last-write-wins on updatedAt.
 *   - Encryption: notes encrypt to the user's OWN pubkey (self-DM), so only
 *     the key holder can read them.
 *
 * Offline: all reads/writes go to IndexedDB instantly via store. This module
 * pushes dirty items when a relay connection is available and reconciles
 * incoming events. While offline, dirty items simply queue in IndexedDB.
 */

import { store } from './store.js';
import { bus } from './eventbus.js';
import { account } from '../features/account.js';
import { relays } from '../features/relays.js';
import * as nip44 from './nip44.js';
import { npubToPk, toHex } from './nostr.js';

const KIND_ITEM = 30078;
const KIND_DELETE = 5;
const CLIENT_TAG = 'bitos-notes';
const SUB_ID = 'bitos-sync-' + Math.random().toString(36).slice(2, 8);
const FLUSH_DEBOUNCE_MS = 1500;
const RECONNECT_MS = 15000;

const state = {
  sockets: new Map(),    // url → WebSocket
  pubkeyHex: null,       // current account pubkey (hex)
  skBytes: null,         // current account secret (32 bytes) — null for NIP-07/npub
  connected: false,
  flushing: false,
  flushTimer: null,
  reconnectTimer: null,
  lastSyncAt: null,
};

/* ---------- status broadcasting ---------- */

function emitStatus(extra = {}) {
  const pending = countDirty();
  const st = state.connected ? (pending > 0 ? 'syncing' : 'synced') : 'offline';
  bus.emit('sync:status', {
    state: st,
    connected: state.connected,
    lastSyncAt: state.lastSyncAt,
    pending,
    ...extra,
  });
}

function countDirty() {
  const notes = store.getNotes();
  const folders = store.getFolders();
  return notes.filter(n => n.syncState === 'dirty').length
       + folders.filter(f => f.syncState === 'dirty').length;
}

/* ---------- event (de)serialization ---------- */

/** Build the JSON payload for a note/folder that goes into the encrypted content. */
function itemPayload(item, type) {
  if (type === 'note') {
    return {
      t: 'note',
      id: item.id,
      folder: item.folder,
      title: item.title || '',
      body: item.body || '',
      pinned: !!item.pinned,
      checklist: item.checklist || [],
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      deletedAt: item.deletedAt || null,
    };
  }
  return {
    t: 'folder',
    id: item.id,
    name: item.name,
    icon: item.icon,
    order: item.order ?? 0,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt || item.createdAt,
  };
}

/* ---------- connection lifecycle ---------- */

/**
 * Start syncing for the current account. No-op if no account or already running.
 * Called by app boot (if an account exists) and on account:changed.
 */
async function connect() {
  const acc = account.current();
  if (!acc) { emitStatus(); return; }

  // Resolve the hex pubkey + (if available) the local secret key.
  let pkHex;
  try {
    if (acc.rawPubkey) pkHex = acc.rawPubkey;
    else if (acc.npub) pkHex = toHex(npubToPk(acc.npub));
    else return;
  } catch { return; }

  // Disconnect any prior session (different account, etc.).
  if (state.pubkeyHex && state.pubkeyHex !== pkHex) disconnect();

  state.pubkeyHex = pkHex;
  state.skBytes = account.rawSecret();   // null for NIP-07 / npub-only

  openSockets();
  emitStatus();
}

/** Open WebSocket subscriptions to all read-enabled relays. */
function openSockets() {
  if (!state.pubkeyHex) return;
  const readRelays = relays.all().filter(r => r.read);
  for (const r of readRelays) {
    if (state.sockets.has(r.url)) continue;
    openOne(r.url);
  }
}

function openOne(url) {
  let ws;
  try { ws = new WebSocket(url); }
  catch { return; }
  state.sockets.set(url, ws);

  ws.onopen = () => {
    // Subscribe to our own parameterized-replaceable app-data events.
    const filter = JSON.stringify(['REQ', SUB_ID, {
      kinds: [KIND_ITEM, KIND_DELETE],
      authors: [state.pubkeyHex],
    }]);
    try { ws.send(filter); } catch {}

    // If at least one relay is up, we're "online" — flush queued dirty items.
    if (!state.connected) {
      state.connected = true;
      flushDirty();
      emitStatus();
    }
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!Array.isArray(msg)) return;
    if (msg[0] === 'EVENT' && msg[2]) onRemoteEvent(msg[2]);
    // EOSE / NOTICE etc. ignored for v0.
  };

  ws.onerror = () => { /* individual relay error; others may still work */ };
  ws.onclose = () => {
    state.sockets.delete(url);
    if (state.sockets.size === 0) {
      state.connected = false;
      emitStatus();
      scheduleReconnect();
    }
  };
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (account.current() && state.pubkeyHex) openSockets();
  }, RECONNECT_MS);
}

/** Stop all sync activity (account disconnected). */
function disconnect() {
  if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null; }
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  for (const [url, ws] of state.sockets) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(['CLOSE', SUB_ID]));
      ws.close();
    } catch {}
  }
  state.sockets.clear();
  state.connected = false;
  state.pubkeyHex = null;
  state.skBytes = null;
  emitStatus();
}

/* ---------- incoming reconciliation ---------- */

async function onRemoteEvent(ev) {
  // Only accept our own events (relay already filtered, but double-check).
  if (ev.pubkey !== state.pubkeyHex) return;

  if (ev.kind === KIND_DELETE) {
    // NIP-09 deletion. Mark the referenced item as removed locally.
    for (const tag of ev.tags || []) {
      if (tag[0] === 'e') handleRemoteDelete(tag[1]);
    }
    return;
  }

  if (ev.kind !== KIND_ITEM) return;

  // Find the d-tag (item id) and type tag.
  let itemId = null, itemType = null;
  for (const tag of ev.tags || []) {
    if (tag[0] === 'd') itemId = tag[1];
    if (tag[0] === 't' && (tag[1] === 'note' || tag[1] === 'folder')) itemType = tag[1];
  }
  if (!itemId || !itemType) return;

  // Decrypt + parse the payload. We need our secret key for decryption.
  if (!state.skBytes) return;   // NIP-07-only accounts can't decrypt in-page (v0 limitation)
  let payload;
  try {
    const pt = await nip44.decrypt(ev.content, state.skBytes, hexToBytes(state.pubkeyHex));
    payload = JSON.parse(pt);
  } catch {
    return;   // couldn't decrypt / parse — skip
  }

  reconcile(itemType, itemId, payload, ev.id);
}

function reconcile(type, itemId, remote, eventId) {
  if (type === 'note') {
    const local = store.getNote(itemId);
    if (!local || (remote.updatedAt || 0) >= (local.updatedAt || 0)) {
      // Remote is newer (or new to us) → upsert, mark synced.
      store.putNote({
        id: remote.id,
        folder: remote.folder,
        title: remote.title,
        body: remote.body,
        pinned: remote.pinned,
        checklist: remote.checklist || [],
        createdAt: remote.createdAt,
        updatedAt: remote.updatedAt,
        deletedAt: remote.deletedAt || null,
        syncState: 'synced',
        _remoteEventId: eventId,
      });
      bus.emit('notes:changed', { id: itemId, remote: true });
    }
  } else if (type === 'folder') {
    const local = store.getFolder(itemId);
    if (!local || (remote.updatedAt || 0) >= (local.updatedAt || 0)) {
      store.putFolder({
        id: remote.id,
        name: remote.name,
        icon: remote.icon,
        system: false,
        createdAt: remote.createdAt,
        order: remote.order ?? 0,
        updatedAt: remote.updatedAt || remote.createdAt,
        syncState: 'synced',
      });
      bus.emit('folders:changed');
    }
  }
  state.lastSyncAt = Date.now();
  emitStatus();
}

function handleRemoteDelete(eventId) {
  // v0: we don't have a precise local→eventId map yet; deletion events are
  // informational. Real hard-delete replication arrives with tombstone tracking.
  // For now, no-op to avoid clobbering local data.
}

/* ---------- outgoing push ---------- */

/**
 * Publish a single note or folder as an encrypted 30078 event.
 */
async function pushItem(item, type) {
  if (!state.pubkeyHex) return;
  const payload = itemPayload(item, type);

  // We need a secret key to encrypt. NIP-07 accounts can sign but our v0
  // encryption path needs the raw key — so NIP-07 accounts skip publishing
  // until a NIP-07 encrypt path is added. (Reads still work.)
  if (!state.skBytes) return;

  const pkBytes = hexToBytes(state.pubkeyHex);
  const content = await nip44.encrypt(JSON.stringify(payload), state.skBytes, pkBytes);

  const unsigned = {
    kind: KIND_ITEM,
    created_at: Math.floor((payload.updatedAt || Date.now()) / 1000),
    tags: [
      ['d', payload.id],
      ['client', CLIENT_TAG],
      ['t', type],
    ],
    content,
  };

  let signed;
  try {
    signed = await account.signEvent(unsigned);
  } catch (e) {
    console.warn('[sync] sign failed', e);
    return;
  }

  // Send to all write-enabled relays.
  const msg = JSON.stringify(['EVENT', signed]);
  let sent = 0;
  for (const r of relays.all()) {
    if (!r.write) continue;
    const ws = state.sockets.get(r.url);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); sent++; } catch {}
    }
  }

  // Remember the published event id so we can later NIP-09-delete it.
  if (signed.id) {
    const ids = (await store.getMeta('publishedEventIds')) || {};
    ids[payload.id] = signed.id;
    store.setMeta('publishedEventIds', ids);
  }
}

/**
 * Push every dirty note + folder. Debounced after local edits; also called
 * on (re)connect.
 */
async function flushDirty() {
  if (state.flushing || !state.connected || !state.pubkeyHex) return;
  state.flushing = true;
  try {
    const dirtyNotes = store.getNotes().filter(n => n.syncState === 'dirty');
    const dirtyFolders = store.getFolders().filter(f => f.syncState === 'dirty');

    for (const n of dirtyNotes) {
      await pushItem(n, 'note');
      markSynced('note', n.id);
    }
    for (const f of dirtyFolders) {
      await pushItem(f, 'folder');
      markSynced('folder', f.id);
    }

    if (dirtyNotes.length || dirtyFolders.length) {
      state.lastSyncAt = Date.now();
    }
    emitStatus();
  } catch (e) {
    console.warn('[sync] flush failed', e);
    bus.emit('sync:status', { state: 'error', error: String(e) });
  } finally {
    state.flushing = false;
  }
}

/** Mark an item synced in IndexedDB (without emitting a change that loops back). */
function markSynced(type, id) {
  if (type === 'note') {
    const n = store.getNote(id);
    if (n) store.putNote({ ...n, syncState: 'synced' });
  } else {
    const f = store.getFolder(id);
    if (f) store.putFolder({ ...f, syncState: 'synced' });
  }
}

/** Debounced flush trigger after local edits. */
function scheduleFlush() {
  if (state.flushTimer) clearTimeout(state.flushTimer);
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    if (state.connected) flushDirty();
    else emitStatus();   // still offline — reflect pending count
  }, FLUSH_DEBOUNCE_MS);
  emitStatus();
}

/* ---------- bus wiring ---------- */

let _wired = false;
function wire() {
  if (_wired) return;
  _wired = true;

  bus.on('notes:changed', () => { if (state.pubkeyHex) scheduleFlush(); });
  bus.on('folders:changed', () => { if (state.pubkeyHex) scheduleFlush(); });
  bus.on('account:changed', () => {
    if (account.current()) connect();
    else disconnect();
  });
  bus.on('relays:changed', () => {
    // Relay set changed: reopen sockets to match the new list.
    if (state.pubkeyHex) {
      for (const url of [...state.sockets.keys()]) {
        const ws = state.sockets.get(url);
        try { ws.close(); } catch {}
        state.sockets.delete(url);
      }
      openSockets();
    }
  });
}

/* ---------- helpers ---------- */

function hexToBytes(hex) {
  if (hex.length % 2) throw new Error('hex: odd length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/* ---------- public API ---------- */

export const sync = {
  /** Called once at boot, after store.init(). */
  init() {
    wire();
    if (account.current()) connect();
  },
  /** Manual "sync now" affordance (UI button). */
  now() {
    if (!state.connected) { openSockets(); return; }
    flushDirty();
  },
  connect,
  disconnect,
  status() {
    return { state: state.connected ? (countDirty() > 0 ? 'syncing' : 'synced') : 'offline', lastSyncAt: state.lastSyncAt, pending: countDirty() };
  },
  /** Internal: expose an open socket for a relay URL (or null). Lets other
   *  modules (e.g. profile publish) reuse the pool instead of new sockets. */
  socket(url) { return state.sockets.get(url) || null; },
};
