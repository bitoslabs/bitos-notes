/**
 * features/folders.js
 * Folder domain logic (SRP: CRUD + system folders + counts).
 * Pure data — rendering lives in ui/sidebar.js.
 */

import { store } from '../core/store.js';
import { bus } from '../core/eventbus.js';
import { i18n } from '../core/i18n.js';

const SYSTEM = [
  { id: 'all',     icon: '☁️', system: true, labelKey: 'folders.allIcloud' },
  { id: 'notes',   icon: '📝', system: true, labelKey: 'folders.notes' },
  { id: 'deleted', icon: '🗑️', system: true, labelKey: 'folders.recentlyDeleted' },
];

const EMOJI_POOL = ['📁', '🗂️', '📦', '🔖', '⭐', '🎯', '📚', '🎨', '✨', '🚀'];

/** Allowed sort modes for the user folder list. System folders always stay pinned. */
const SORT_MODES = ['manual', 'name', 'created'];
const DEFAULT_SORT = 'manual';

/** Compare two user folders under a sort mode. */
function compareFolders(a, b, mode) {
  switch (mode) {
    case 'name':     return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    case 'created':  return (a.createdAt || 0) - (b.createdAt || 0);
    case 'manual':
    default:         return (a.order ?? 0) - (b.order ?? 0);  // stable insertion order
  }
}

export const folders = {
  /** Allowed sort modes — exposed for the settings/popup UI. */
  get sortModes() { return SORT_MODES; },

  /** Current folder sort mode ('manual' | 'name' | 'created'). */
  get sortMode()  { return store.getPrefs().folderSort || DEFAULT_SORT; },
  set sortMode(mode) {
    if (!SORT_MODES.includes(mode)) return;
    store.setPrefs({ folderSort: mode });
    bus.emit('folders:changed');
  },

  /** All folders: system (pinned) + user, in the active sort order. */
  all() {
    const user = [...store.getFolders()].sort((a, b) => compareFolders(a, b, this.sortMode));
    return [...SYSTEM, ...user];
  },

  /** Localized display name for a folder. */
  name(f) {
    return f.system ? i18n.t(f.labelKey) : f.name;
  },

  /** Count notes under a folder (respects trash semantics). */
  count(folderId, notes) {
    if (folderId === 'all')     return notes.filter(n => n.folder !== 'deleted').length;
    if (folderId === 'deleted') return notes.filter(n => n.folder === 'deleted').length;
    return notes.filter(n => n.folder === folderId).length;
  },

  /** Create a user folder. Returns the new folder. */
  create(name) {
    const list = store.getFolders();
    const folder = {
      id: 'f' + Date.now(),
      name: name?.trim() || i18n.t('folders.defaultName'),
      icon: EMOJI_POOL[Math.floor(Math.random() * EMOJI_POOL.length)],
      system: false,
      createdAt: Date.now(),                    // captured so 'Sort by Date Created' works
      order: list.length,                       // stable position for 'manual' sort
      syncState: 'dirty',
    };
    store.setFolders([...list, folder]);
    bus.emit('folders:changed');
    return folder;
  },

  /** Rename a user folder (system folders are immutable). */
  rename(id, name) {
    const list = store.getFolders().map(f =>
      f.id === id ? { ...f, name: name.trim(), syncState: 'dirty' } : f
    );
    store.setFolders(list);
    bus.emit('folders:changed');
  },

  /** Remove a user folder; its notes fall back to 'notes'. */
  remove(id) {
    store.setFolders(store.getFolders().filter(f => f.id !== id));
    // Reassign every note that lived in the deleted folder back to Notes,
    // matching the documented behavior (and macOS Notes). Bump syncState so
    // the moved notes republish with their new folder.
    store.setNotes(
      store.getNotes().map(n =>
        n.folder === id ? { ...n, folder: 'notes', syncState: 'dirty' } : n
      )
    );
    bus.emit('folders:changed');
    bus.emit('notes:changed');
  },
};
