/**
 * features/editor.js
 * Editor controller (SRP: binds contenteditable fields + toolbar to a note).
 * Knows nothing about the notes list or sidebar — only the editor pane.
 *
 * Lifecycle:
 *   editor.load(note)   → fill title/body/checklist + show pane
 *   editor.clear()      → show empty state
 *   editor.getTitle()   → current title text
 *   <user edits>        → onInput → notes.update(...) (debounced)
 */

import { notes, stripHtml } from './notes.js';
import { i18n } from '../core/i18n.js';
import { bus } from '../core/eventbus.js';

const $ = (id) => document.getElementById(id);

let currentId = null;
let saveTimer = null;

export const editor = {
  get currentId() { return currentId; },

  init() {
    // Live save on title/body edit.
    $('editor-title').addEventListener('input', () => this._scheduleSave());
    $('editor-body').addEventListener('input', () => this._scheduleSave());

    // Toolbar commands.
    document.querySelectorAll('[data-cmd]').forEach(btn => {
      btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep selection
      btn.addEventListener('click', () => this.execCommand(btn.dataset.cmd));
    });

    // Re-apply placeholder language on locale change.
    bus.on('locale:changed', () => {
      if (currentId) this.refreshMeta();
    });
  },

  /** Load a note into the editor. */
  load(note) {
    if (!note) return this.clear();
    currentId = note.id;

    $('editor-title').textContent = note.title || '';
    $('editor-meta').textContent = this._metaText(note);
    $('editor-date').textContent = notes.dateLabel(note);

    const body = $('editor-body');
    body.innerHTML = '';

    // Checklist block (if any).
    if (note.checklist?.length) {
      const block = document.createElement('div');
      block.className = 'checklist-block';
      note.checklist.forEach((item, i) => block.appendChild(this._checkRow(item, i)));
      body.appendChild(block);
    }

    // Body content.
    const p = document.createElement('div');
    p.innerHTML = note.body || '';
    body.appendChild(p);

    this._showEmpty(false);
    this._setPinIcon(note.pinned);
  },

  /** Show the empty state and detach. */
  clear() {
    currentId = null;
    $('editor-title').textContent = '';
    $('editor-body').innerHTML = '';
    $('editor-meta').textContent = '';
    $('editor-date').textContent = '';
    this._showEmpty(true);
  },

  /** Re-render meta after a pin toggle or locale change. */
  refreshMeta() {
    const n = notes.find(currentId);
    if (n) {
      $('editor-meta').textContent = this._metaText(n);
      $('editor-date').textContent = notes.dateLabel(n);
      this._setPinIcon(n.pinned);
    }
  },

  /** Execute a toolbar command (or insert a checklist row). */
  execCommand(cmd) {
    if (cmd === 'checklist') return this.insertChecklistRow();
    if (cmd === 'title') {
      // Toggle an <h3> on the current line (Apple's "Title" style).
      document.execCommand('formatBlock', false, 'h3');
    } else if (document.execCommand) {
      document.execCommand(cmd, false, null);
    }
    this._scheduleSave();
    $('editor-body').focus();
  },

  /** Insert a new checkable row at the caret. */
  insertChecklistRow() {
    const row = this._checkRow({ t: '', d: false }, -1);
    row.contentEditable = false;
    // Make the text editable.
    const span = row.querySelector('span');
    span.contentEditable = true;
    $('editor-body').focus();
    const sel = window.getSelection();
    if (sel.rangeCount) {
      const range = sel.getRangeAt(0);
      range.insertNode(row);
      range.setStart(span, 0);
      range.collapse(true);
      sel.removeAllRanges(); sel.addRange(range);
    } else {
      $('editor-body').appendChild(row);
    }
    span.focus();
    this._scheduleSave();
  },

  /** Build a single checklist row (checkbox + text). */
  _checkRow(item, index) {
    const row = document.createElement('label');
    row.className = 'check-item' + (item.d ? ' done' : '');
    row.dataset.noteField = 'checklist';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!item.d;
    const span = document.createElement('span');
    span.textContent = item.t;
    cb.addEventListener('change', () => {
      row.classList.toggle('done', cb.checked);
      this._persistChecklist();
    });
    span.addEventListener('input', () => this._scheduleSave());
    row.appendChild(cb);
    row.appendChild(span);
    return row;
  },

  /** Read the checklist block (if present) into data. */
  _readChecklist() {
    const block = $('editor-body').querySelector('.checklist-block');
    if (!block) return [];
    return [...block.querySelectorAll('.check-item')].map(row => ({
      t: row.querySelector('span')?.textContent || '',
      d: row.querySelector('input')?.checked || false,
    }));
  },

  _persistChecklist() {
    if (!currentId) return;
    notes.update(currentId, { checklist: this._readChecklist() });
  },

  /** Debounced save of title + body + checklist. */
  _scheduleSave() {
    if (!currentId) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      notes.update(currentId, {
        title: $('editor-title').textContent.trim(),
        body: this._readBodyHtml(),
        checklist: this._readChecklist(),
      });
    }, 300);
  },

  /** Body = everything in editor-body EXCEPT the checklist block. */
  _readBodyHtml() {
    const clone = $('editor-body').cloneNode(true);
    clone.querySelector('.checklist-block')?.remove();
    return clone.innerHTML;
  },

  _metaText(n) {
    return notes.dateLabel(n) + (n.pinned ? '  ·  📌 ' + i18n.t('editor.pinned') : '');
  },

  _showEmpty(empty) {
    $('editor-empty').classList.toggle('hidden', !empty);
    $('editor-wrap').classList.toggle('hidden', empty);
    $('toolbar').style.display = empty ? 'none' : 'flex';
  },

  _setPinIcon(pinned) {
    $('pin-btn').style.color = pinned ? 'var(--notes-yellow)' : '';
  },
};
