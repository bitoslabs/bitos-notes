/**
 * ui/notelist.js
 * Renders the notes list pane (SRP: rendering + selection only).
 * Reads from features/notes.js + ui/sidebar.js (active folder); edits go through
 * notes domain; opening a note is announced on the bus.
 */

import { notes, stripHtml } from '../features/notes.js';
import { sidebar } from './sidebar.js';
import { i18n } from '../core/i18n.js';
import { bus } from '../core/eventbus.js';
import { store } from '../core/store.js';
import * as popup from './popup.js';
import * as dialog from './dialog.js';

const $ = (id) => document.getElementById(id);
let activeNoteId = null;
let search = '';

const SORT_OPTIONS = [
  { id: 'updated', labelKey: 'sort.dateUpdated' },
  { id: 'created', labelKey: 'sort.dateCreated' },
  { id: 'title',   labelKey: 'sort.title' },
];

export const noteList = {
  get activeId() { return activeNoteId; },

  init() {
    $('new-note-btn').addEventListener('click', () => this._onNew());
    $('delete-btn').addEventListener('click', () => this._onDelete());
    $('pin-btn').addEventListener('click', () => this._onPin());
    $('share-btn').addEventListener('click', () => this._onShare());
    $('sort-btn').addEventListener('click', (e) => this._showSortMenu(e.currentTarget));

    $('notes-list').addEventListener('click', (e) => {
      // Empty-state quick-create: clicking the hint creates a note.
      if (e.target.closest('.notes-empty-create')) return this._onNew();
      const card = e.target.closest('[data-note]');
      if (card) this.select(+card.dataset.note || card.dataset.note);
    });

    bus.on('search:changed',  (q) => { search = q; this.render(); });
    bus.on('notes:changed',   () => this.render());
    bus.on('folder:selected', () => { activeNoteId = null; this.render(); });
    bus.on('locale:changed',  () => this.render());

    // Centralised quick-create: any UI surface can emit `quick:create`
    // (empty states, keyboard shortcut) and it routes here.
    bus.on('quick:create', () => this._onNew());

    // Global keyboard shortcut: ⌘N / Ctrl-N creates a note even when the
    // focus is in the editor or sidebar. Will not fire while typing in
    // inputs, contenteditable, or modals.
    document.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'n') return;
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      const isEditable = document.activeElement?.isContentEditable
        || tag === 'input' || tag === 'textarea';
      const modalOpen = !$('settings-modal').classList.contains('hidden');
      if (modalOpen || isEditable) return;
      e.preventDefault();
      this._onNew();
    });
  },

  /** Select + open a note in the editor. */
  select(id) {
    const n = notes.find(id);
    if (!n) return;
    activeNoteId = id;
    store.setPrefs({ lastNote: id });
    this.render();
    bus.emit('note:selected', n);
  },

  render() {
    const folderId = sidebar.active;
    const list = notes.query({ folderId, search });
    const wrap = $('notes-list');

    if (!list.length) {
      wrap.innerHTML = `<button class="notes-empty-create" type="button">
        <div class="notes-empty">${i18n.t('notes.empty')}</div>
        <div class="notes-empty-hint"><span class="plus">+</span> ${i18n.t('notes.emptyHint')}</div>
      </button>`;
      this._renderCount(0);
      return;
    }

    const pinned = list.filter(n => n.pinned);
    const rest = list.filter(n => !n.pinned);
    let html = '';

    if (pinned.length && !search) {
      html += `<div class="list-section">📌 ${i18n.t('editor.pinned')}</div>`;
      html += pinned.map(card).join('');
    }

    // Non-pinned notes: group by date when sorting by a date field, exactly
    // like macOS Notes. Title-sort and active search flatten to one list.
    const mode = notes.sortMode;
    const groupByDate = (mode === 'updated' || mode === 'created') && !search;

    if (groupByDate && rest.length) {
      html += renderGrouped(rest, mode);
    } else if (rest.length) {
      // Title sort or search → flat list. Single "All Notes" header only
      // when not searching (search hides all section headers).
      if (!search) html += `<div class="list-section">${i18n.t('editor.allNotes')}</div>`;
      html += rest.map(card).join('');
    }

    wrap.innerHTML = html;
    this._renderCount(list.length);

    /** Render non-pinned notes grouped into consecutive date sections. */
    function renderGrouped(items, sortMode) {
      let out = '';
      let currentKey = null;
      for (const n of items) {
        const bucket = notes.dateBucket(n, sortMode);
        if (bucket.key !== currentKey) {
          currentKey = bucket.key;
          out += `<div class="list-section">${escapeHtml(bucket.label)}</div>`;
        }
        out += card(n);
      }
      return out;
    }

    function card(n) {
      const preview = notes.preview(n) || '';
      const pinIcon = n.pinned ? `<svg class="nc-pin" viewBox="0 0 24 24"><path d="M12 17v5l-2-1v-4L5 12V7h14v5z"/></svg>` : '';
      return `
        <div class="note-card ${activeNoteId === n.id ? 'active' : ''}" data-note="${n.id}">
          <div class="nc-title">${pinIcon}<span class="nc-title-text">${escapeHtml(n.title) || i18n.t('notes.untitled')}</span></div>
          ${preview ? `<div class="nc-preview">${escapeHtml(preview)}</div>` : ''}
          <div class="nc-date">${notes.dateLabel(n)}</div>
        </div>`;
    }
  },

  _renderCount(n) {
    const key = n === 1 ? 'notes.note_one' : 'notes.note_other';
    $('note-count').textContent = `${n} ${i18n.t(key)}`;
  },

  _onNew() {
    const folder = sidebar.active === 'all' || sidebar.active === 'deleted' ? 'notes' : sidebar.active;
    const n = notes.create(folder);
    this.select(n.id);
    bus.emit('toast', i18n.t('toast.noteCreated'));
  },

  async _onDelete() {
    if (!activeNoteId) return;
    const n = notes.find(activeNoteId);
    if (!n) return;
    const inTrash = n.folder === 'deleted';

    const hasTitle   = !!(n.title && n.title.trim());
    const hasBody    = !!(n.body && stripHtml(n.body).trim());
    const hasCheck   = !!(n.checklist && n.checklist.some(i => i && i.t && i.t.trim()));
    const isEmpty    = !hasTitle && !hasBody && !hasCheck;

    if (inTrash) {
      // Permanent deletion from the trash — always confirm.
      const ok = await dialog.confirm({
        kind: 'danger',
        destructiveDanger: true,
        title: i18n.t('confirm.deleteForever'),
        message: i18n.t('confirm.deleteForever'),
        detail: i18n.t('confirm.deleteForeverDetail'),
        confirmText: i18n.t('editor.delete'),
      });
      if (!ok) return;
    } else if (!isEmpty) {
      // Non-empty note — give the user one easy safety check.
      const ok = await dialog.confirm({
        kind: 'danger',
        destructiveDanger: true,
        title: i18n.t('editor.delete'),
        message: i18n.t('confirm.deleteNote', { title: n.title?.trim() || i18n.t('notes.untitled') }),
        detail: i18n.t('confirm.deleteNoteDetail'),
        confirmText: i18n.t('editor.delete'),
      });
      if (!ok) return;
    }
    // Empty notes delete silently — no friction for clearing drafts.
    notes.remove(activeNoteId);
    activeNoteId = null;
    this.render();
    bus.emit('toast', i18n.t('toast.noteDeleted'));
    bus.emit('note:selected', null);
  },

  _onPin() {
    if (!activeNoteId) return;
    const n = notes.find(activeNoteId);
    notes.togglePin(activeNoteId);
    bus.emit('toast', i18n.t(n.pinned ? 'toast.noteUnpinned' : 'toast.notePinned'));
  },

  _onShare() {
    const n = notes.find(activeNoteId);
    const hasChecklist = !!n?.checklist?.some(item => item?.t?.trim());
    if (!n || (!n.title && !n.body && !hasChecklist)) {
      bus.emit('toast', i18n.t('toast.empty'));
      return;
    }
    // Mock: copy a share link to clipboard.
    const url = `${location.origin}/#/n/${n.id}`;
    navigator.clipboard?.writeText(url).catch(() => {});
    bus.emit('toast', i18n.t('toast.shared'));
  },

  /** Show the Sort By menu (macOS Notes style). */
  _showSortMenu(anchor) {
    const current = notes.sortMode;
    const body = [
      popup.header(i18n.t('sort.menu')),
      ...SORT_OPTIONS.map(o =>
        popup.item({ id: o.id, label: i18n.t(o.labelKey), checked: current === o.id })
      ),
    ];
    popup.open(anchor, body, (id) => {
      if (!SORT_OPTIONS.some(o => o.id === id) || id === current) return;
      notes.sortMode = id;
      this.render();
      const opt = SORT_OPTIONS.find(o => o.id === id);
      bus.emit('toast', i18n.t('sort.toast', { mode: i18n.t(opt.labelKey) }));
    });
  },
};

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}
