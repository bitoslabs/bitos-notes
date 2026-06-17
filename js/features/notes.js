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

  /** Notes visible in a folder, respecting trash + search filter. */
  query({ folderId, search = '' } = {}) {
    let list = this.all().filter(n => {
      if (folderId === 'all')     return n.folder !== 'deleted';
      if (folderId === 'deleted') return n.folder === 'deleted';
      return n.folder === folderId;
    });
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(n =>
        (n.title || '').toLowerCase().includes(q) ||
        stripHtml(n.body).toLowerCase().includes(q)
      );
    }
    // Sort: pinned first, then most-recently-updated.
    return list.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
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
    const text = stripHtml(n.body).replace(/\s+/g, ' ').trim();
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
