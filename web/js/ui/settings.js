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
import { profile } from '../features/profile.js';
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
    $('account-disconnect-btn-2').addEventListener('click', () => this._disconnectAccount());
    $('account-setup-btn').addEventListener('click', () => {
      this.close();
      // "Manage account…" when connected → connected step; else the setup wizard.
      accountModal.open(account.current() ? 'connected' : 'choose');
    });
    $('account-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') this._connectAccount(); });

    // Profile editor
    $('profile-edit-btn').addEventListener('click', () => this._toggleProfileEditor(true));
    $('profile-cancel-btn').addEventListener('click', () => this._toggleProfileEditor(false));
    $('profile-save-btn').addEventListener('click', () => this._saveProfile(false));
    $('profile-publish-btn').addEventListener('click', () => this._publishProfile());

    // Key widget (inside the profile card)
    $('s-copy-npub').addEventListener('click', () => this._sCopyNpub());
    $('s-show-nsec').addEventListener('click', (e) => this._sToggleNsec(e.currentTarget));
    $('s-copy-nsec').addEventListener('click', () => this._sCopyNsec());
    $('s-download-nsec').addEventListener('click', () => this._sDownloadNsec());

    // Data
    $('export-btn').addEventListener('click', () => this._export());
    $('import-btn').addEventListener('click', () => $('import-file').click());
    $('import-file').addEventListener('change', (e) => this._import(e));
    $('reset-btn').addEventListener('click', () => this._reset());
    $('force-update-btn')?.addEventListener('click', () => this._forceUpdate());

    bus.on('relays:changed', () => this._renderRelays());
    bus.on('locale:changed', () => { this._renderRelays(); this._syncLang(); this.renderAccount(); });
    bus.on('account:changed', () => this.renderAccount());
    bus.on('profile:changed', () => this._renderProfile());
  },

  open() {
    this._syncTheme();
    this._syncAccent();
    this._syncLang();
    this._renderRelays();
    // Collapse the profile editor on each open.
    $('profile-editor').classList.add('hidden');
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
    const form = $('account-form');
    const rowActions = $('account-row-actions');
    const connect = $('account-connect-btn');
    const nip07 = $('account-nip07-btn');
    const disconnect = $('account-disconnect-btn');
    const setup = $('account-setup-btn');
    const status = $('account-status');

    if (acc) {
      // Connected → show the profile card, hide the inline connect form.
      form.classList.add('hidden');
      rowActions.classList.add('hidden');
      $('profile-card').classList.remove('hidden');
      // Keep the (now hidden) power-user controls in sync too.
      disconnect.classList.remove('hidden');
      setup.textContent = i18n.t('settings.accountManage');
      status.innerHTML = '';
      this._renderProfile();
    } else {
      // Not connected → show the inline connect form, hide the profile card.
      form.classList.remove('hidden');
      rowActions.classList.remove('hidden');
      $('profile-card').classList.add('hidden');
      $('profile-editor').classList.add('hidden');
      $('account-input').value = '';
      $('account-input').type = 'text';
      connect.classList.remove('hidden');
      nip07.classList.remove('hidden');
      disconnect.classList.add('hidden');
      setup.textContent = i18n.t('settings.accountSetup');
      status.innerHTML = `<div class="account-status-muted">${i18n.t('settings.accountOffline')}</div>`;
    }
  },

  /** Render the profile card + populate the editor inputs. */
  _renderProfile() {
    const acc = account.current();
    if (!acc) return;
    const p = profile.current();
    const name = (p && (p.displayName || p.name)) || acc.displayName || account.shortNpub(acc.npub || '');
    const about = (p && p.about) || '';
    const picture = (p && p.picture) || '';
    const nip05 = (p && p.nip05) || '';
    const verified = !!(p && p.nip05Verified);

    const avatar = $('profile-avatar');
    if (picture) {
      avatar.innerHTML = `<img src="${escapeAttr(picture)}" alt="" onerror="this.parentNode.textContent='${escapeAttr((name||'N').slice(0,1).toUpperCase())}'">`;
    } else {
      avatar.textContent = (name || 'N').slice(0, 1).toUpperCase();
    }
    $('profile-name').textContent = name;
    const nip05El = $('profile-nip05');
    if (nip05) {
      nip05El.innerHTML = `<span class="nip05-chip ${verified ? 'verified' : ''}">${verified ? '<svg viewBox="0 0 24 24" class="ico"><path d="M20 6L9 17l-5-5"/></svg>' : ''}${escapeHtml(nip05)}</span>`;
    } else { nip05El.innerHTML = ''; }
    $('profile-source').textContent = i18n.t('account.source.' + (acc.source || 'npub'));
    $('profile-about').textContent = about;
    $('profile-about').classList.toggle('hidden', !about);

    // Pre-fill the editor fields.
    $('profile-name-input').value = (p && p.name) || '';
    $('profile-about-input').value = about;
    $('profile-picture-input').value = picture;
    $('profile-nip05-input').value = nip05;

    // Disable Publish for read-only (npub) accounts.
    const canSign = acc.source !== 'npub';
    $('profile-publish-btn').disabled = !canSign;
    $('profile-publish-btn').title = canSign ? '' : i18n.t('profile.readOnlySign');
    $('profile-edit-btn').disabled = !canSign;

    // Key widget: populate npub (always) + nsec row (nsec accounts only).
    $('s-npub').textContent = acc.npub || '—';
    const nsec = account.revealSecret();
    const nsecRow = $('s-nsec-row');
    if (nsec) {
      nsecRow.classList.remove('hidden');
      $('s-nsec').textContent = nsec;
      this._sMasked = true;
      $('s-nsec').classList.add('masked');
      $('s-show-nsec').textContent = i18n.t('account.show');
    } else {
      nsecRow.classList.add('hidden');
    }
  },

  _toggleProfileEditor(show) {
    $('profile-editor').classList.toggle('hidden', !show);
    if (show) { $('profile-name-input').focus(); }
  },

  /* ---------- Key widget (inside the profile card) ---------- */

  _sMasked: true,

  async _sCopyNpub() {
    const npub = account.current()?.npub || '';
    try { await navigator.clipboard.writeText(npub); bus.emit('toast', i18n.t('account.npubCopied')); }
    catch { bus.emit('toast', i18n.t('profile.copyFailed')); }
  },

  _sToggleNsec(btn) {
    this._sMasked = !this._sMasked;
    $('s-nsec').classList.toggle('masked', this._sMasked);
    btn.textContent = i18n.t(this._sMasked ? 'account.show' : 'account.hide');
  },

  async _sCopyNsec() {
    const nsec = account.revealSecret();
    if (!nsec) { bus.emit('toast', i18n.t('account.noBackup')); return; }
    try { await navigator.clipboard.writeText(nsec); bus.emit('toast', i18n.t('account.copied')); }
    catch { bus.emit('toast', i18n.t('profile.copyFailed')); }
  },

  _sDownloadNsec() {
    const nsec = account.revealSecret();
    if (!nsec) { bus.emit('toast', i18n.t('account.noBackup')); return; }
    const blob = new Blob([nsec], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bitos-nostr-key-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    bus.emit('toast', i18n.t('account.downloaded'));
  },

  /** Save the editor fields locally (optionally publish). */
  async _saveProfile(publish) {
    const patch = {
      name: $('profile-name-input').value.trim(),
      displayName: $('profile-name-input').value.trim(),
      about: $('profile-about-input').value.trim(),
      picture: $('profile-picture-input').value.trim(),
      nip05: $('profile-nip05-input').value.trim(),
    };
    await profile.update(patch);
    if (publish) {
      const btn = $('profile-publish-btn');
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = i18n.t('profile.publishing');
      try {
        const ok = await profile.publish();
        bus.emit('toast', ok ? i18n.t('profile.published') : i18n.t('profile.publishFailed'));
        if (ok) this._toggleProfileEditor(false);
      } catch (e) {
        bus.emit('toast', i18n.t('profile.publishFailed'));
      } finally {
        btn.disabled = account.current()?.source === 'npub';
        btn.textContent = original;
      }
    } else {
      bus.emit('toast', i18n.t('profile.saved'));
    }
  },

  _publishProfile() { return this._saveProfile(true); },


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
    }).then(async (ok) => {
      if (!ok) return;
      await store.clearAll();
      location.reload();
    });
  },

  _forceUpdate() {
    dialog.confirm({
      kind: 'warn',
      title: i18n.t('settings.forceUpdate'),
      message: i18n.t('settings.forceUpdatePrompt'),
      detail: i18n.t('settings.forceUpdateDetail'),
      confirmText: i18n.t('settings.forceUpdate'),
      cancelText: i18n.t('dialog.cancel'),
    }).then(async (ok) => {
      if (!ok) return;

      try {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(async (reg) => {
            try { await reg.update(); } catch {}
            try { await reg.unregister(); } catch {}
          }));
        }
        if ('caches' in window) {
          await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
        }
      } finally {
        location.reload();
      }
    });
  },
};

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

/** Attribute-safe escape (for inline HTML string building). */
function escapeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
