/**
 * features/notes.js
 * Notes domain logic (SRP: CRUD, pin, trash, search, sorting).
 * Pure data operations. UI rendering lives in ui/notelist.js + ui/editor.js.
 *
 * Note shape:
 *   {
 *     id, folder, title, body, pinned,
 *     checklist: legacy flat items[] OR grouped blocks[{ id, items[] }],
 *     createdAt, updatedAt, deletedAt?
 *   }
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
      syncState: 'dirty',
    };
    store.setNotes([note, ...this.all()]);
    bus.emit('notes:changed');
    return note;
  },

  /** Patch a note with partial fields + bump updatedAt. */
  update(id, patch) {
    const list = this.all().map(n =>
      n.id === id ? { ...n, ...patch, updatedAt: Date.now(), syncState: 'dirty' } : n
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
    if (!n) return;
    const groups = normalizeChecklistGroups(n.checklist);
    let seen = 0;
    for (const group of groups) {
      for (const item of group.items) {
        if (seen === index) {
          item.d = !item.d;
          this.update(id, { checklist: groups });
          return;
        }
        seen += 1;
      }
    }
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

  /**
   * Bucket a note into a date section for list grouping (macOS Notes style).
   * Respects the sort mode: 'updated' uses updatedAt, 'created' uses createdAt.
   * Returns { key, label } where `key` orders newest-first and `label` is the
   * localized section header. Pure function; does not depend on sort order.
   */
  dateBucket(n, mode = 'updated') {
    const ts = mode === 'created' ? (n.createdAt || 0) : (n.updatedAt || 0);
    const d = new Date(ts);
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;

    if (ts <= 0 || isNaN(d.getTime())) {
      return { key: 'older', label: i18n.t('notes.sectionOlder') };
    }
    // Calendar-day comparisons (ignore time) for Today / Yesterday.
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - dayMs;
    const noteDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

    if (noteDay >= startOfToday) {
      return { key: 'today', label: i18n.t('notes.sectionToday') };
    }
    if (noteDay >= startOfYesterday) {
      return { key: 'yesterday', label: i18n.t('notes.sectionYesterday') };
    }
    if (ts > startOfYesterday - 6 * dayMs) {       // within the previous 7 days
      return { key: 'last7', label: i18n.t('notes.sectionPrevious7') };
    }
    if (ts > startOfYesterday - 29 * dayMs) {      // within the previous 30 days
      return { key: 'last30', label: i18n.t('notes.sectionPrevious30') };
    }
    // Older: group per calendar month, labelled "March 2025" (auto-localized).
    // The key is zero-padded so lexical order = chronological order.
    const monthKey = `m-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString([], { month: 'long', year: 'numeric' });
    return { key: monthKey, label };
  },
};

/* ---- helpers ---- */

export function stripHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  return (tmp.textContent || tmp.innerText || '').trim();
}

export function normalizeChecklistGroups(checklist) {
  if (!Array.isArray(checklist) || !checklist.length) return [];

  const first = checklist[0];
  if (first && Array.isArray(first.items)) {
    return checklist
      .map((group, index) => ({
        id: group.id || `legacy-group-${index}`,
        items: (group.items || [])
          .map(item => ({ t: item?.t || '', d: !!item?.d }))
          .filter(item => item.t || item.d),
      }))
      .filter(group => group.items.length);
  }

  const items = checklist
    .map(item => ({ t: item?.t || '', d: !!item?.d }))
    .filter(item => item.t || item.d);
  return items.length ? [{ id: 'legacy-group-0', items }] : [];
}

export function flattenChecklistItems(checklist) {
  return normalizeChecklistGroups(checklist).flatMap(group => group.items);
}

export function hasChecklistContent(checklist) {
  return flattenChecklistItems(checklist).some(item => item.t.trim());
}

function noteText(note) {
  const bodyText = stripHtml(note.body);
  const checklistText = flattenChecklistItems(note.checklist)
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
