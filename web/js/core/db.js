/**
 * core/db.js
 * Promise-based IndexedDB wrapper (SRP: only this module talks to IndexedDB).
 *
 * Stores:
 *   - notes   (keyPath: 'id')  → note records
 *   - folders (keyPath: 'id')  → user folder records
 *   - meta    (keyPath: 'key') → sync bookkeeping ({key, value})
 *
 * If IndexedDB is unavailable (private mode / disabled / quota), the wrapper
 * transparently falls back to an in-memory Map per store so the app keeps
 * running for the session. Callers don't need to know which backend is live.
 */

const DB_NAME = 'bitos-notes';
const DB_VERSION = 1;
const STORES = ['notes', 'folders', 'meta'];

let _db = null;            // resolved IDBDatabase, or null if using fallback
let _fallback = null;      // Map<storeName, Map<key, value>> when IDB is absent
let _fallbackReady = false;

/* ------------------------------------------------------------------ *
 * Fallback backend (in-memory) — used only when IndexedDB is gone.
 * ------------------------------------------------------------------ */

function fallback() {
  if (!_fallback) {
    _fallback = new Map();
    for (const s of STORES) _fallback.set(s, new Map());
  }
  return _fallback;
}

function fbGetAll(store) {
  return Promise.resolve([...fallback().get(store).values()]);
}
function fbGet(store, id) {
  return Promise.resolve(fallback().get(store).get(id) ?? null);
}
function fbPut(store, item) {
  const key = item.id ?? item.key;
  fallback().get(store).set(key, item);
  return Promise.resolve(item);
}
function fbBulkPut(store, items) {
  const m = fallback().get(store);
  for (const it of items) {
    const key = it.id ?? it.key;
    m.set(key, it);
  }
  return Promise.resolve();
}
function fbDel(store, id) {
  fallback().get(store).delete(id);
  return Promise.resolve();
}

/* ------------------------------------------------------------------ *
 * Real IndexedDB backend.
 * ------------------------------------------------------------------ */

function open() {
  if (_db) return Promise.resolve(_db);
  if (_fallbackReady) return Promise.resolve(null);

  return new Promise((resolve) => {
    let req;
    try {
      if (typeof indexedDB === 'undefined') {
        _fallbackReady = true;
        return resolve(null);
      }
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      _fallbackReady = true;
      return resolve(null);
    }

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notes'))   db.createObjectStore('notes',   { keyPath: 'id' });
      if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta'))    db.createObjectStore('meta',    { keyPath: 'key' });
    };

    req.onsuccess = () => {
      _db = req.result;
      _db.onversionchange = () => { try { _db.close(); } catch {} _db = null; };
      resolve(_db);
    };

    // If open itself fails, switch to fallback so the app still boots.
    req.onerror = () => { _fallbackReady = true; resolve(null); };
    req.onblocked = () => { _fallbackReady = true; resolve(null); };
  });
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

function idbGetAll(store) {
  return reqToPromise(tx(_db, store, 'readonly').getAll());
}
function idbGet(store, id) {
  return reqToPromise(tx(_db, store, 'readonly').get(id));
}
function idbPut(store, item) {
  return reqToPromise(tx(_db, store, 'readwrite').put(item));
}
function idbBulkPut(store, items) {
  return new Promise((resolve, reject) => {
    const t = _db.transaction(store, 'readwrite');
    const os = t.objectStore(store);
    for (const it of items) os.put(it);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
function idbDel(store, id) {
  return reqToPromise(tx(_db, store, 'readwrite').delete(id));
}

/** Wipe notes + folders + meta (used by the reset flow). */
function clearAll() {
  if (_db) {
    return Promise.all(STORES.map((s) =>
      new Promise((resolve) => {
        try {
          const t = _db.transaction(s, 'readwrite');
          t.objectStore(s).clear();
          t.oncomplete = () => resolve();
          t.onerror = () => resolve();
          t.onabort = () => resolve();
        } catch { resolve(); }
      })
    ));
  }
  if (_fallbackReady) {
    for (const s of STORES) fallback().get(s).clear();
  }
  return Promise.resolve();
}

export const db = {
  open,
  clearAll,
  isReady: () => !!_db,

  getAll(store)  { return _db ? idbGetAll(store)  : fbGetAll(store);  },
  get(store, id) { return _db ? idbGet(store, id) : fbGet(store, id); },
  put(store, item) {
    if (item == null) return Promise.resolve();
    return _db ? idbPut(store, item) : fbPut(store, item);
  },
  bulkPut(store, items) {
    const list = items ?? [];
    if (!list.length) return Promise.resolve();
    return _db ? idbBulkPut(store, list) : fbBulkPut(store, list);
  },
  del(store, id) { return _db ? idbDel(store, id) : fbDel(store, id); },

  /* ---- meta store (key/value) convenience ---- */
  getMeta(key) {
    return this.get('meta', key).then((row) => (row ? row.value : null));
  },
  setMeta(key, value) {
    return this.put('meta', { key, value });
  },
};
