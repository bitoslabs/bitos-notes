/**
 * core/store.js
 * Persistence layer (SRP: only this module talks to localStorage).
 * Each domain (notes, folders, relays, prefs) has its own namespaced key.
 * Other modules call store.get/set; they never touch localStorage directly.
 */

const PREFIX = 'bitos.notes.';
const KEYS = {
  notes: PREFIX + 'notes',
  folders: PREFIX + 'folders',
  relays: PREFIX + 'relays',
  prefs: PREFIX + 'prefs',     // { lang, theme, lastFolder, lastNote }
};

const memory = {}; // fallback when localStorage is unavailable (private mode)

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return memory[key] ?? null;
  }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { memory[key] = value; }
  return value;
}

export const store = {
  /* ---- Notes ---- */
  getNotes() { return read(KEYS.notes) ?? []; },
  setNotes(notes) { write(KEYS.notes, notes); },

  /* ---- Folders ---- */
  getFolders() { return read(KEYS.folders) ?? []; },
  setFolders(folders) { write(KEYS.folders, folders); },

  /* ---- Relays ---- */
  getRelays() { return read(KEYS.relays) ?? []; },
  setRelays(relays) { write(KEYS.relays, relays); },

  /* ---- Preferences ---- */
  getPrefs() {
    return read(KEYS.prefs) ?? { lang: null, theme: 'system', lastFolder: 'all', lastNote: null };
  },
  setPrefs(patch) {
    const next = { ...this.getPrefs(), ...patch };
    write(KEYS.prefs, next);
    return next;
  },

  /* ---- Danger zone ---- */
  clearAll() {
    Object.values(KEYS).forEach((k) => {
      try { localStorage.removeItem(k); } catch {}
      delete memory[k];
    });
  },
};
