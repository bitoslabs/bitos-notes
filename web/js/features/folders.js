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

export const folders = {
  /** All folders: system + user, in display order. */
  all() {
    const user = store.getFolders();
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
    };
    store.setFolders([...list, folder]);
    bus.emit('folders:changed');
    return folder;
  },

  /** Rename a user folder (system folders are immutable). */
  rename(id, name) {
    const list = store.getFolders().map(f => f.id === id ? { ...f, name: name.trim() } : f);
    store.setFolders(list);
    bus.emit('folders:changed');
  },

  /** Remove a user folder; its notes fall back to 'notes'. */
  remove(id) {
    store.setFolders(store.getFolders().filter(f => f.id !== id));
    bus.emit('folders:changed');
  },
};
