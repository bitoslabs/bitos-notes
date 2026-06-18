/**
 * core/store.js
 * Persistence layer (SRP: only this module talks to durable storage).
 *
 * Notes + folders live in IndexedDB (via core/db.js) behind a synchronous
 * in-memory cache that is hydrated once at boot by init(). All reads stay
 * synchronous (from the cache) and all writes update the cache synchronously
 * then persist to IndexedDB write-through. This keeps the existing sync
 * call sites (notes.js, folders.js, editor.js, UI modules) unchanged.
 *
 * prefs / relays / account stay in localStorage — they're small and were
 * already working; no reason to churn them.
 */

import { db } from './db.js';

const PREFIX = 'bitos.notes.';
const KEYS = {
  notes: PREFIX + 'notes',     // legacy localStorage key, used only for migration
  folders: PREFIX + 'folders', // legacy localStorage key, used only for migration
  relays: PREFIX + 'relays',
  account: PREFIX + 'account',
  prefs: PREFIX + 'prefs',     // { lang, theme, lastFolder, lastNote, sort, folderSort }
};

const memory = {}; // fallback when localStorage is unavailable (private mode)

/* ---- in-memory caches (hydrated by init()) ---- */
let _notesCache = [];        // array of all notes
let _notesIndex = new Map(); // id → note (mirror of _notesCache for O(1) lookups)
let _foldersCache = [];      // user folders only (system folders are NOT stored)
let _foldersIndex = new Map();
let _inited = false;

/* ============================================================
 * localStorage helpers (used by prefs/relays/account + migration)
 * ============================================================ */

function readLS(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return memory[key] ?? null;
  }
}

function writeLS(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { memory[key] = value; }
  return value;
}

function removeLS(key) {
  try { localStorage.removeItem(key); } catch {}
  delete memory[key];
}

/* ============================================================
 * Boot / migration
 * ============================================================ */

/**
 * Open IndexedDB, hydrate caches, and (once) migrate any pre-existing
 * localStorage notes/folders into IndexedDB. Must be awaited before the
 * first read of notes/folders. Safe to call multiple times.
 */
async function init() {
  if (_inited) return;
  _inited = true;

  await db.open();

  // Load whatever is already in IndexedDB.
  const [notes, folders] = await Promise.all([
    db.getAll('notes'),
    db.getAll('folders'),
  ]);

  const migrated = await db.getMeta('migrated');
  const legacyNotes = readLS(KEYS.notes);
  const legacyFolders = readLS(KEYS.folders);

  if (!migrated) {
    // First run on this DB. Fold any legacy localStorage data in, marking
    // every migrated item dirty so it publishes on first sync.
    const noteMap = new Map(notes.map((n) => [n.id, n]));
    if (Array.isArray(legacyNotes)) {
      for (const n of legacyNotes) {
        if (!n || !n.id) continue;
        noteMap.set(n.id, { ...n, syncState: n.syncState || 'dirty' });
      }
    }
    const folderMap = new Map(folders.map((f) => [f.id, f]));
    if (Array.isArray(legacyFolders)) {
      for (const f of legacyFolders) {
        if (!f || !f.id) continue;
        folderMap.set(f.id, { ...f, syncState: f.syncState || 'dirty' });
      }
    }

    const mergedNotes = [...noteMap.values()];
    const mergedFolders = [...folderMap.values()];

    await Promise.all([
      db.bulkPut('notes', mergedNotes),
      db.bulkPut('folders', mergedFolders),
      db.setMeta('migrated', true),
      db.setMeta('schemaVersion', 1),
    ]);

    // Legacy notes/folders keys are now redundant; remove them so we don't
    // re-migrate on a fresh DB. prefs/relays/account stay in localStorage.
    removeLS(KEYS.notes);
    removeLS(KEYS.folders);

    _notesCache = mergedNotes;
    _foldersCache = mergedFolders;
  } else {
    _notesCache = notes;
    _foldersCache = folders;
  }

  rebuildIndex(_notesIndex, _notesCache);
  rebuildIndex(_foldersIndex, _foldersCache);
}

function rebuildIndex(idx, list) {
  idx.clear();
  for (const item of list) if (item && item.id != null) idx.set(item.id, item);
}

/* ============================================================
 * Cache + write-through persistence
 * ============================================================ */

// Fire-and-forget persistence. We never want a write failure to crash the
// editor mid-keystroke; logged and surfaced via the sync status instead.
function persistNotes() {
  db.bulkPut('notes', _notesCache).catch((e) => console.warn('[store] notes persist failed', e));
}
function persistFolders() {
  db.bulkPut('folders', _foldersCache).catch((e) => console.warn('[store] folders persist failed', e));
}

export const store = {
  /** One-time hydration. Await before first notes/folders read. */
  init,
  isReady: () => _inited,

  /* ---- Notes (IndexedDB-backed, sync cache reads) ---- */
  getNotes() { return _notesCache; },
  setNotes(notes) {
    _notesCache = Array.isArray(notes) ? notes : [];
    rebuildIndex(_notesIndex, _notesCache);
    persistNotes();
  },

  getNote(id) { return _notesIndex.get(id) ?? null; },
  putNote(note) {
    if (!note || note.id == null) return;
    const i = _notesCache.findIndex((n) => n.id === note.id);
    if (i >= 0) _notesCache[i] = note;
    else _notesCache.push(note);
    _notesIndex.set(note.id, note);
    db.put('notes', note).catch((e) => console.warn('[store] putNote failed', e));
  },
  deleteNote(id) {
    _notesCache = _notesCache.filter((n) => n.id !== id);
    _notesIndex.delete(id);
    db.del('notes', id).catch((e) => console.warn('[store] deleteNote failed', e));
  },

  /* ---- Folders (user folders only; system folders live in folders.js) ---- */
  getFolders() { return _foldersCache; },
  setFolders(folders) {
    _foldersCache = Array.isArray(folders) ? folders : [];
    rebuildIndex(_foldersIndex, _foldersCache);
    persistFolders();
  },

  getFolder(id) { return _foldersIndex.get(id) ?? null; },
  putFolder(folder) {
    if (!folder || folder.id == null) return;
    const i = _foldersCache.findIndex((f) => f.id === folder.id);
    if (i >= 0) _foldersCache[i] = folder;
    else _foldersCache.push(folder);
    _foldersIndex.set(folder.id, folder);
    db.put('folders', folder).catch((e) => console.warn('[store] putFolder failed', e));
  },
  deleteFolder(id) {
    _foldersCache = _foldersCache.filter((f) => f.id !== id);
    _foldersIndex.delete(id);
    db.del('folders', id).catch((e) => console.warn('[store] deleteFolder failed', e));
  },

  /* ---- Relays (localStorage, unchanged) ---- */
  getRelays() { return readLS(KEYS.relays) ?? []; },
  setRelays(relays) { writeLS(KEYS.relays, relays); },

  /* ---- Account (localStorage, unchanged) ---- */
  getAccount() { return readLS(KEYS.account); },
  setAccount(account) { writeLS(KEYS.account, account); },

  /* ---- Preferences (localStorage, unchanged, merge-set) ---- */
  getPrefs() {
    return readLS(KEYS.prefs) ?? { lang: null, theme: 'system', lastFolder: 'all', lastNote: null, sort: 'updated' };
  },
  setPrefs(patch) {
    const next = { ...this.getPrefs(), ...patch };
    writeLS(KEYS.prefs, next);
    return next;
  },

  /* ---- Danger zone ---- */
  async clearAll() {
    // Wipe IndexedDB stores + legacy keys + everything in localStorage.
    _notesCache = [];
    _foldersCache = [];
    _notesIndex.clear();
    _foldersIndex.clear();
    await db.clearAll().catch(() => {});
    Object.values(KEYS).forEach((k) => removeLS(k));
  },

  /* ---- sync bookkeeping (meta store, async) ---- */
  getMeta(key) { return db.getMeta(key); },
  setMeta(key, value) { return db.setMeta(key, value); },
};
