/**
 * ui/settings.js
 * Settings modal (SRP: renders modal + binds its controls).
 * Delegates actual work to theme/i18n/relays/store modules — owns no business
 * logic itself.
 */

import { theme } from '../core/theme.js';
import { i18n } from '../core/i18n.js';
import { relays } from '../features/relays.js';
import { notes } from '../features/notes.js';
import { store } from '../core/store.js';
import { bus } from '../core/eventbus.js';

const $ = (id) => document.getElementById(id);
let addingRelay = false;

export const settings = {
  init() {
    $('settings-btn').addEventListener('click', () => this.open());
    $('settings-close').addEventListener('click', () => this.close());
    $('settings-modal').addEventListener('click', (e) => {
      if (e.target.id === 'settings-modal') this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });

    // Theme segmented control
    $('theme-segmented').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-theme]');
      if (btn) { theme.setMode(btn.dataset.theme); this._syncTheme(); }
    });

    // Language segmented control
    $('lang-segmented').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-lang]');
      if (btn) { i18n.setLocale(btn.dataset.lang); this._syncLang(); }
    });

    // Relays
    $('add-relay-btn').addEventListener('click', () => this._toggleAddRow(true));
    $('relay-list').addEventListener('click', (e) => this._onRelayClick(e));

    // Data
    $('export-btn').addEventListener('click', () => this._export());
    $('import-btn').addEventListener('click', () => $('import-file').click());
    $('import-file').addEventListener('change', (e) => this._import(e));
    $('reset-btn').addEventListener('click', () => this._reset());

    bus.on('relays:changed', () => this._renderRelays());
    bus.on('locale:changed', () => { this._renderRelays(); this._syncLang(); });
  },

  open() {
    this._syncTheme();
    this._syncLang();
    this._renderRelays();
    $('settings-modal').classList.remove('hidden');
    $('settings-modal').setAttribute('aria-hidden', 'false');
  },

  close() {
    $('settings-modal').classList.add('hidden');
    $('settings-modal').setAttribute('aria-hidden', 'true');
    this._toggleAddRow(false);
  },

  _syncTheme() {
    const mode = theme.mode;
    $('theme-segmented').querySelectorAll('[data-theme]').forEach(b => {
      b.classList.toggle('active', b.dataset.theme === mode);
    });
  },

  _syncLang() {
    const lang = i18n.locale;
    $('lang-segmented').querySelectorAll('[data-lang]').forEach(b => {
      b.classList.toggle('active', b.dataset.lang === lang);
    });
  },

  /* ---------- Relays ---------- */

  _renderRelays() {
    const list = relays.all();
    const wrap = $('relay-list');
    if (!list.length) {
      wrap.innerHTML = `<div class="notes-empty">${i18n.t('notes.empty')}</div>`;
      return;
    }
    wrap.innerHTML = list.map(r => {
      const status = r.status === 'ok' ? 'ok' : r.status === 'fail' ? 'fail' : r.status === 'checking' ? 'checking' : '';
      const latencyLabel = r.status === 'ok' && r.latency != null ? ` · ${r.latency}ms` : '';
      return `
        <div class="relay-row">
          <span class="relay-status ${status}" title="${i18n.t('relays.status.' + (status || 'unknown'))}"></span>
          <span class="relay-url" title="${r.url}">${r.url}</span>
          <span class="relay-flags">
            <span class="relay-flag ${r.read  ? 'on' : ''}">${i18n.t('relays.read')}</span>
            <span class="relay-flag ${r.write ? 'on' : ''}">${i18n.t('relays.write')}</span>
          </span>
          <span class="relay-actions">
            <button class="relay-mini-btn" data-action="test" data-url="${r.url}" title="${i18n.t('relays.test')}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 12A10 10 0 1 1 12 2"/><path d="M22 2 12 12"/></svg>
            </button>
            <button class="relay-mini-btn" data-action="remove" data-url="${r.url}" title="${i18n.t('relays.remove')}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            </button>
          </span>
          <span class="relay-latency" style="font-size:11px;color:var(--text-secondary)">${latencyLabel}</span>
        </div>`;
    }).join('');
  },

  _onRelayClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, url } = btn.dataset;
    if (action === 'test') {
      relays.test(url).then(r => {
        bus.emit('toast', r.status === 'ok'
          ? i18n.t('relays.testedOk', { ms: r.latency })
          : i18n.t('relays.testedFail'));
      });
    } else if (action === 'remove') {
      relays.remove(url);
      bus.emit('toast', i18n.t('relays.removed'));
    }
  },

  _toggleAddRow(show) {
    const wrap = $('relay-list');
    let row = wrap.querySelector('.relay-add-row');
    if (!show) { row?.remove(); addingRelay = false; return; }
    if (row) { row.querySelector('input').focus(); return; }
    row = document.createElement('div');
    row.className = 'relay-add-row';
    row.innerHTML = `
      <input type="text" placeholder="${i18n.t('relays.placeholder')}" />
      <button class="ghost-btn" data-add-confirm>${i18n.t('relays.add')}</button>`;
    wrap.appendChild(row);
    const input = row.querySelector('input');
    input.focus();
    const submit = () => {
      const res = relays.add(input.value);
      if (!res.ok) { bus.emit('toast', i18n.t(res.error)); return; }
      this._toggleAddRow(false);
      bus.emit('toast', i18n.t('relays.added'));
    };
    row.querySelector('[data-add-confirm]').addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') this._toggleAddRow(false); });
  },

  /* ---------- Data ---------- */

  _export() {
    const payload = {
      app: 'bitos-notes',
      version: 1,
      exportedAt: new Date().toISOString(),
      notes: notes.all(),
      folders: store.getFolders(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bitos-notes-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    bus.emit('toast', i18n.t('toast.exported', { count: payload.notes.length }));
  },

  async _import(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const imported = Array.isArray(data.notes) ? data.notes : [];
      const existing = notes.all();
      // Merge by id; imported overwrites on conflict.
      const map = new Map(existing.map(n => [n.id, n]));
      imported.forEach(n => map.set(n.id, n));
      store.setNotes([...map.values()]);
      bus.emit('notes:changed');
      bus.emit('toast', i18n.t('toast.imported', { count: imported.length }));
    } catch {
      bus.emit('toast', 'Import failed');
    } finally {
      e.target.value = '';
    }
  },

  _reset() {
    if (!confirm(i18n.t('confirm.reset'))) return;
    store.clearAll();
    location.reload();
  },
};
