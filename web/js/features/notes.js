/**
 * features/notes.js
 * Notes domain logic (SRP: CRUD, pin, trash, search, sorting).
 * Pure data operations. UI rendering lives in ui/notelist.js + ui/editor.js.
 *
 * Note shape:
 *   { id, folder, title, body, pinned, checklist[], createdAt, updatedAt, deletedAt? }
 */

import { store } from '../core/store.js';
import { bus } from '../core/eventbus.js';
import { i18n } from '../core/i18n.js';

export const notes = {
  /** All notes from localStorage. */
  all() {
    return store.getNotes();
  },

  find(id) { return this.all().find(n => n.id === id) || null; },

  /** Current sort preference (stored in prefs). */
  get sortMode() { return store.getPrefs().sort || 'updated'; },
  set sortMode(v) { store.setPrefs({ sort: v }); },

  /** Notes visible in a folder, respecting trash + search filter + sort. */
  query({ folderId, search = '', sort } = {}) {
    let list = this.all().filter(n => {
      if (folderId === 'all')     return n.folder !== 'deleted';
      if (folderId === 'deleted') return n.folder === 'deleted';
      return n.folder === folderId;
    });
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(n =>
        (n.title || '').toLowerCase().includes(q) ||
        noteText(n).toLowerCase().includes(q)
      );
    }
    // Sort: pinned always first, then per the chosen ordering.
    //   'updated' → most-recently-updated first (default)
    //   'created' → most-recently-created first
    //   'title'   → alphabetical (A→Z), case-insensitive
    const mode = sort || this.sortMode;
    const cmp = mode === 'created'
      ? (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
      : mode === 'title'
        ? (a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base', numeric: true })
        : (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
    return list.sort((a, b) => (b.pinned - a.pinned) || cmp(a, b));
  },

  /** Create a note in a folder. Returns the new note. */
  create(folder = 'notes') {
    const now = Date.now();
    const note = {
      id: 'n' + now,
      folder: folder === 'all' || folder === 'deleted' ? 'notes' : folder,
      title: '',
      body: '',
      pinned: false,
      checklist: [],
      createdAt: now,
      updatedAt: now,
    };
    store.setNotes([note, ...this.all()]);
    bus.emit('notes:changed');
    return note;
  },

  /** Patch a note with partial fields + bump updatedAt. */
  update(id, patch) {
    const list = this.all().map(n =>
      n.id === id ? { ...n, ...patch, updatedAt: Date.now() } : n
    );
    store.setNotes(list);
    bus.emit('notes:changed', { id, patch });
  },

  /** Toggle pin. */
  togglePin(id) {
    const n = this.find(id);
    if (!n) return;
    this.update(id, { pinned: !n.pinned });
  },

  /** Soft-delete (move to trash) or hard-delete (when already in trash). */
  remove(id) {
    const n = this.find(id);
    if (!n) return;
    if (n.folder === 'deleted') {
      store.setNotes(this.all().filter(x => x.id !== id));
    } else {
      this.update(id, { folder: 'deleted', deletedAt: Date.now(), pinned: false });
    }
    bus.emit('notes:changed');
  },

  /** Restore a note from trash back to Notes. */
  restore(id) {
    this.update(id, { folder: 'notes', deletedAt: null });
  },

  /** Toggle a checklist item's done state by index. */
  toggleCheck(id, index) {
    const n = this.find(id);
    if (!n || !n.checklist[index]) return;
    n.checklist[index].d = !n.checklist[index].d;
    this.update(id, { checklist: [...n.checklist] });
  },

  /** Human-readable preview (first ~80 chars of body, no HTML). */
  preview(n) {
    const text = noteText(n).replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 80) : '';
  },

  /** Localized relative date label. */
  dateLabel(n) {
    return formatDate(n.updatedAt);
  },
};

/* ---- helpers ---- */

export function stripHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  return (tmp.textContent || tmp.innerText || '').trim();
}

function noteText(note) {
  const bodyText = stripHtml(note.body);
  const checklistText = (note.checklist || [])
    .map(item => item?.t || '')
    .filter(Boolean)
    .join(' ');
  return [bodyText, checklistText].filter(Boolean).join(' ').trim();
}

function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const isYest = d.toDateString() === yest.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return i18n.t('editor.today') + ' ' + time;
  if (isYest)  return i18n.t('editor.yesterday');
  // same year → month+day, else full date
  const opts = d.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' };
  return d.toLocaleDateString([], opts);
}
