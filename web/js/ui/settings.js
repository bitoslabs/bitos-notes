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
import { account } from '../features/account.js';
import { store } from '../core/store.js';
import { bus } from '../core/eventbus.js';
import { accountModal } from './account.js';
import * as dialog from './dialog.js';

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

    // Accent color picker (built dynamically from theme.accents)
    this._buildAccentSwatches();
    $('accent-swatches').addEventListener('click', (e) => {
      const sw = e.target.closest('[data-accent]');
      if (!sw) return;
      theme.setAccent(sw.dataset.accent);
      this._syncAccent();
    });

    // Language select
    this._buildLangOptions();
    $('lang-select').addEventListener('change', (e) => {
      i18n.setLocale(e.target.value);
    });

    // Relays
    $('add-relay-btn').addEventListener('click', () => this._toggleAddRow(true));
    $('relay-list').addEventListener('click', (e) => this._onRelayClick(e));

    // Account
    $('account-connect-btn').addEventListener('click', () => this._connectAccount());
    $('account-nip07-btn').addEventListener('click', () => this._connectNip07());
    $('account-disconnect-btn').addEventListener('click', () => this._disconnectAccount());
    $('account-setup-btn').addEventListener('click', () => {
      this.close();
      accountModal.open('choose');
    });
    $('account-backup-btn').addEventListener('click', () => this._backupKey());
    $('account-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') this._connectAccount(); });

    // Data
    $('export-btn').addEventListener('click', () => this._export());
    $('import-btn').addEventListener('click', () => $('import-file').click());
    $('import-file').addEventListener('change', (e) => this._import(e));
    $('reset-btn').addEventListener('click', () => this._reset());

    bus.on('relays:changed', () => this._renderRelays());
    bus.on('locale:changed', () => { this._renderRelays(); this._syncLang(); this.renderAccount(); });
    bus.on('account:changed', () => this.renderAccount());
  },

  open() {
    this._syncTheme();
    this._syncAccent();
    this._syncLang();
    this._renderRelays();
    this.renderAccount();
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

  /** Build the swatch row once from theme.accents. Active state synced later by _syncAccent(). */
  _buildAccentSwatches() {
    const wrap = $('accent-swatches');
    if (!wrap) return;
    wrap.innerHTML = theme.accents.map(a => `
      <button type="button"
              class="accent-swatch"
              data-accent="${a.id}"
              role="radio"
              aria-checked="false"
              aria-label="${a.name}"
              title="${a.name}"
              style="--swatch:${a.hex}"></button>`).join('');
  },

  _syncAccent() {
    const current = theme.accent;
    $('accent-swatches')?.querySelectorAll('[data-accent]').forEach(sw => {
      const on = sw.dataset.accent === current;
      sw.classList.toggle('active', on);
      sw.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  },

  _syncLang() {
    const lang = i18n.locale;
    const select = $('lang-select');
    if (select) select.value = lang;
  },

  _buildLangOptions() {
    const select = $('lang-select');
    if (!select) return;
    select.innerHTML = Object.entries(i18n.supported).map(([code, info]) => {
      const label = info.native === info.name ? info.native : `${info.native} — ${info.name}`;
      return `<option value="${code}">${label}</option>`;
    }).join('');
    select.value = i18n.locale;
  },

  /* ---------- Account ---------- */

  renderAccount() {
    const acc = account.current();
    const input = $('account-input');
    const connect = $('account-connect-btn');
    const nip07 = $('account-nip07-btn');
    const disconnect = $('account-disconnect-btn');
    const setup = $('account-setup-btn');
    const backup = $('account-backup-btn');
    const status = $('account-status');

    if (acc) {
      // Never echo the full private key back into the field — it encourages
      // accidental copy-paste. Show the public identity instead.
      input.value = acc.npub || (acc.rawPubkey ? 'npub1' + acc.rawPubkey : '');
      input.type = 'text';
      connect.classList.add('hidden');
      nip07.classList.add('hidden');
      disconnect.classList.remove('hidden');
      setup.textContent = i18n.t('settings.accountManage');
      // Backup is only meaningful when we hold the secret locally.
      if (account.revealSecret()) backup.classList.remove('hidden');
      else backup.classList.add('hidden');
      const sourceLabel = i18n.t('account.source.' + (acc.source || 'npub'));
      status.innerHTML = `
        <div class="account-status-ok">● ${i18n.t('settings.accountConnected')}</div>
        <div class="account-status-line">${escapeHtml(acc.displayName)}</div>
        <div class="account-status-line">${escapeHtml(sourceLabel)}</div>`;
    } else {
      input.value = '';
      input.type = 'text';
      connect.classList.remove('hidden');
      nip07.classList.remove('hidden');
      disconnect.classList.add('hidden');
      setup.textContent = i18n.t('settings.accountSetup');
      backup.classList.add('hidden');
      status.innerHTML = `<div class="account-status-muted">${i18n.t('settings.accountOffline')}</div>`;
    }
  },

  _connectAccount() {
    const res = account.connect($('account-input').value);
    if (res.then) {
      res.then(r => this._handleConnectResult(r));
    } else {
      this._handleConnectResult(res);
    }
  },

  async _connectNip07() {
    this._handleConnectResult(await account.connect('nip07'));
  },

  _handleConnectResult(res) {
    if (!res.ok) {
      bus.emit('toast', i18n.t(res.error));
      this.renderAccount();
      return;
    }
    bus.emit('toast', i18n.t('toast.accountConnected'));
    this.renderAccount();
  },

  _disconnectAccount() {
    const acc = account.current();
    const holdsSecret = !!account.revealSecret();
    // Losing a key-backed account is recoverable only if the user has the
    // nsec backed up — surface that in the dialog.
    const message = holdsSecret && acc?.source === 'nsec'
      ? i18n.t('account.disconnectWarn')
      : i18n.t('settings.accountDisconnect');
    dialog.confirm({
      kind: 'danger',
      destructiveDanger: true,
      title: i18n.t('settings.accountDisconnect'),
      message,
      detail: i18n.t('account.disconnectDetail'),
      confirmText: i18n.t('settings.accountDisconnect'),
    }).then((ok) => {
      if (!ok) return;
      account.disconnect();
      bus.emit('toast', i18n.t('toast.accountDisconnected'));
      this.renderAccount();
    });
  },

  /** Show the stored private key again so the user can re-back it up. */
  async _backupKey() {
    const nsec = account.revealSecret();
    if (!nsec) {
      bus.emit('toast', i18n.t('account.noBackup'));
      return;
    }
    const ok = await dialog.confirm({
      kind: 'warn',
      title: i18n.t('account.backupTitle'),
      message: i18n.t('account.backupReveal'),
      detail: i18n.t('account.backupRevealDetail'),
      confirmText: i18n.t('account.reveal'),
      cancelText: i18n.t('dialog.cancel'),
    });
    if (!ok) return;
    await dialog.alert({
      title: i18n.t('account.yourKey'),
      message: nsec,
      detail: i18n.t('account.backupDesc'),
      confirmText: i18n.t('account.done'),
    });
    // Best-effort clipboard copy with a toast acknowledgement.
    try {
      await navigator.clipboard.writeText(nsec);
      bus.emit('toast', i18n.t('account.copied'));
    } catch {}
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
      <input type="text" class="text-input" placeholder="${i18n.t('relays.placeholder')}" />
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
    dialog.confirmTyped({
      kind: 'danger',
      destructiveDanger: true,
      title: i18n.t('settings.reset'),
      message: i18n.t('confirm.reset'),
      detail: i18n.t('confirm.resetDetail'),
      requiresText: true,
      requireMatch: i18n.t('confirm.resetMatch'),
      confirmText: i18n.t('settings.reset'),
    }).then((ok) => {
      if (!ok) return;
      store.clearAll();
      location.reload();
    });
  },
};

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}
