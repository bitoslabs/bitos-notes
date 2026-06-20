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

import { notes, normalizeChecklistGroups, stripHtml } from './notes.js';
import { draw } from './draw.js';
import { i18n } from '../core/i18n.js';
import { bus } from '../core/eventbus.js';

const $ = (id) => document.getElementById(id);
const CHECKLIST_MARKER_ATTR = 'data-checklist-marker';
const CHECKLIST_BLOCK_ID_ATTR = 'data-checklist-id';

let currentId = null;
let saveTimer = null;

export const editor = {
  get currentId() { return currentId; },

  init() {
    // Live save on title/body edit.
    $('editor-title').addEventListener('input', () => this._scheduleSave());
    $('editor-title').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._focusStart($('editor-body')); }
    });
    $('editor-body').addEventListener('input', () => { this._cleanEmptyBody(); this._scheduleSave(); });
    $('editor-body').addEventListener('keydown', (e) => this._onBodyKeydown(e));

    // Toolbar commands.
    document.querySelectorAll('[data-cmd]').forEach(btn => {
      btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep selection
      btn.addEventListener('click', () => this.execCommand(btn.dataset.cmd));
    });

    // Empty-state quick-create: clicking the placeholder creates a note.
    $('editor-empty-create')?.addEventListener('click', () => bus.emit('quick:create'));

    // Re-apply placeholder language on locale change.
    bus.on('locale:changed', () => {
      if (currentId) this.refreshMeta();
    });
  },

  /** Load a note into the editor. */
  load(note) {
    if (!note) return this.clear();
    draw.close();          // tear down any draw overlay from the previous note
    currentId = note.id;

    $('editor-title').textContent = note.title || '';
    $('editor-meta').textContent = this._metaText(note);
    $('editor-date').textContent = notes.dateLabel(note);

    const body = $('editor-body');
    body.innerHTML = note.body || '';
    this._restoreChecklist(body, note.checklist || []);

    this._showEmpty(false);
    this._setPinIcon(note.pinned);
  },

  /** Show the empty state and detach. */
  clear() {
    draw.close();          // exit draw mode when leaving a note
    currentId = null;
    $('editor-title').textContent = '';
    $('editor-body').innerHTML = '';
    $('editor-meta').textContent = '';
    $('editor-date').textContent = '';
    this._showEmpty(true);
  },

  /** Public hook for feature modules (e.g. draw) to trigger the debounced
   *  save. Wraps the private _scheduleSave() so callers don't depend on it. */
  requestSave() { this._scheduleSave(); },

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
    if (cmd === 'draw') return draw.toggle($('editor-body'));
    if (cmd === 'title') {
      // Toggle an <h3> on the current line (Apple's "Title" style).
      document.execCommand('formatBlock', false, 'h3');
    } else if (document.execCommand) {
      document.execCommand(cmd, false, null);
    }
    this._scheduleSave();
    $('editor-body').focus();
  },

  /** Insert a new checklist row near the current caret, then focus its text. */
  insertChecklistRow() {
    const body = $('editor-body');
    const row = this._checkRow({ t: '', d: false });
    const currentRow = this._selectionChecklistRow();

    if (currentRow) {
      currentRow.after(row);
    } else {
      const block = document.createElement('div');
      block.className = 'checklist-block';
      this._ensureChecklistBlockId(block);
      this._insertNodeAtSelection(block);
      block.appendChild(row);
    }

    this._persistChecklist();
    this._scheduleSave();
    this._focusStart(row.querySelector('.check-label'));
  },

  /** Build a single checklist row (checkbox + editable label). */
  _checkRow(item) {
    const row = document.createElement('div');
    row.className = 'check-item' + (item.d ? ' done' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!item.d;
    cb.addEventListener('change', () => {
      row.classList.toggle('done', cb.checked);
      this._applyCheckLabelState(label, cb.checked);
      this._persistChecklist();
      this._scheduleSave();
    });

    const label = document.createElement('input');
    label.type = 'text';
    label.value = item.t || '';
    label.className = item.d ? 'check-label is-done' : 'check-label';
    label.placeholder = '';
    label.addEventListener('input', () => {
      this._persistChecklist();
      this._scheduleSave();
    });
    label.addEventListener('keydown', (e) => this._onChecklistLabelKeydown(e));
    this._applyCheckLabelState(label, cb.checked);

    row.appendChild(cb);
    row.appendChild(label);
    return row;
  },

  _buildChecklistBlock(group) {
    const block = document.createElement('div');
    block.className = 'checklist-block';
    block.setAttribute(CHECKLIST_BLOCK_ID_ATTR, group.id || this._newChecklistId());
    (group.items || []).forEach((item) => block.appendChild(this._checkRow(item)));
    return block;
  },

  _restoreChecklist(body, checklist) {
    const groups = normalizeChecklistGroups(checklist);
    const markers = [...body.querySelectorAll(`[${CHECKLIST_MARKER_ATTR}]`)];
    if (!groups.length) {
      markers.forEach((marker) => marker.remove());
      return;
    }

    const unusedMarkers = [...markers];
    groups.forEach((group, index) => {
      const exact = markers.find((marker) => marker.getAttribute(CHECKLIST_MARKER_ATTR) === group.id);
      const legacy = !exact && index === 0
        ? markers.find((marker) => marker.getAttribute(CHECKLIST_MARKER_ATTR) === 'true')
        : null;
      const target = exact || legacy || unusedMarkers.shift();
      const block = this._buildChecklistBlock(group);
      if (target?.isConnected) {
        target.replaceWith(block);
      } else if (!markers.length && index === 0) {
        body.insertBefore(block, body.firstChild);
      } else {
        body.appendChild(block);
      }
    });
    body.querySelectorAll(`[${CHECKLIST_MARKER_ATTR}]`).forEach((marker) => marker.remove());
  },

  _newChecklistId() {
    return `check-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  },

  _ensureChecklistBlockId(block) {
    if (!block.hasAttribute(CHECKLIST_BLOCK_ID_ATTR)) {
      block.setAttribute(CHECKLIST_BLOCK_ID_ATTR, this._newChecklistId());
    }
    return block.getAttribute(CHECKLIST_BLOCK_ID_ATTR);
  },

  /** Read the checklist block (if present) into data. */
  _readChecklist() {
    return [...$('editor-body').querySelectorAll('.checklist-block')]
      .map((block) => ({
        id: this._ensureChecklistBlockId(block),
        items: [...block.querySelectorAll('.check-item')]
          .map(row => ({
            t: row.querySelector('.check-label')?.value || '',
            d: row.querySelector('input')?.checked || false,
          }))
          .filter(item => item.t || item.d),
      }))
      .filter(group => group.items.length);
  },

  _persistChecklist() {
    if (!currentId) return;
    notes.update(currentId, { checklist: this._readChecklist() });
  },

  _applyCheckLabelState(label, checked) {
    if (!label) return;
    label.classList.toggle('is-done', checked);
    label.style.textDecoration = checked ? 'line-through' : 'none';
    label.style.color = checked ? 'var(--text-secondary)' : '';
  },

  _selectionChecklistRow() {
    const sel = window.getSelection();
    if (!sel?.rangeCount) return null;
    const anchor = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
    return anchor?.closest?.('.check-item') || null;
  },

  _insertNodeAtSelection(node) {
    const body = $('editor-body');
    const sel = window.getSelection();
    if (!sel?.rangeCount) {
      body.appendChild(node);
      return;
    }

    const range = sel.getRangeAt(0);
    const anchor = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    if (!anchor || !body.contains(anchor)) {
      body.appendChild(node);
      return;
    }

    range.collapse(true);
    range.insertNode(node);
  },

  /** Enter / Backspace behaviour inside checklist rows (Apple Notes-style). */
  _onBodyKeydown(e) {
    if (e.target.closest?.('.check-item')) return;
  },

  _onChecklistLabelKeydown(e) {
    const label = e.target.closest?.('.check-label');
    if (!label) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const row = label.parentElement;
      if (!label.value.trim()) {
        // Empty item → exit checklist into a body line.
        const line = document.createElement('div');
        line.innerHTML = '<br>';
        row.closest('.checklist-block')?.after(line);
        row.remove();
        this._pruneEmptyBlock();
        this._focusStart(line);
      } else {
        const next = this._checkRow({ t: '', d: false });
        row.after(next);
        this._focusStart(next.querySelector('.check-label'));
      }
      this._persistChecklist();
      this._scheduleSave();
    } else if (e.key === 'Backspace') {
      if (label.selectionStart !== 0 || label.selectionEnd !== 0) return;
      if (label.value.trim()) return;
      e.preventDefault();
      const row = label.parentElement;
      const prevLabel = row.previousElementSibling?.querySelector('.check-label');
      row.remove();
      this._pruneEmptyBlock();
      this._focusEnd(prevLabel || $('editor-body'));
      this._persistChecklist();
      this._scheduleSave();
    }
  },

  /** Drop the checklist container once it holds no rows. */
  _pruneEmptyBlock() {
    $('editor-body').querySelectorAll('.checklist-block').forEach((block) => {
      if (!block.querySelector('.check-item')) block.remove();
    });
  },

  /** Clear stray <br>/empty wrappers so the :empty body placeholder can show. */
  _cleanEmptyBody() {
    const body = $('editor-body');
    if (body.querySelector('.check-item, .shape-block')) return;
    if (body.textContent.trim() || body.querySelector('img,hr')) return;
    if (body.innerHTML !== '') body.innerHTML = '';
  },

  _focusStart(el) {
    if (!el) return;
    el.focus();
    if (typeof el.setSelectionRange === 'function') {
      el.setSelectionRange(0, 0);
      return;
    }
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  },

  _focusEnd(el) {
    el.focus();
    if (typeof el.setSelectionRange === 'function') {
      const end = el.value.length;
      el.setSelectionRange(end, end);
      return;
    }
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  },

  /** Debounced save of title + body + checklist. */
  _scheduleSave() {
    if (!currentId) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      this._ensureChecklistBlockIds();
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
    clone.querySelectorAll('.checklist-block').forEach((block) => {
      const marker = document.createElement('div');
      marker.setAttribute(
        CHECKLIST_MARKER_ATTR,
        block.getAttribute(CHECKLIST_BLOCK_ID_ATTR) || this._newChecklistId(),
      );
      block.replaceWith(marker);
    });
    return clone.innerHTML;
  },

  _ensureChecklistBlockIds() {
    const body = $('editor-body');
    body.querySelectorAll('.checklist-block').forEach((block) => {
      this._ensureChecklistBlockId(block);
    });
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
