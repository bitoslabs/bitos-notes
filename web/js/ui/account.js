/**
 * ui/account.js
 * Account setup modal — generate, import, or link a Nostr identity, and a
 * backup-key flow that mirrors the Settings modal's look-and-feel.
 *
 * The modal is a small wizard:
 *   Step 1 "choose"  → Create | Import | NIP-07
 *   Step 2 "create"  → show generated nsec (copy/download/hide) and require
 *                      the "I've saved it" checkbox to enable Finish
 *   Step 2 "import"  → paste nsec, validated live, then connect
 *
 * The existing inline form inside Settings still works for power users; this
 * modal is the recommended onboarding path and is also opened from the
 * sidebar account bar / Settings "Manage" button.
 */

import { account } from '../features/account.js';
import { profile } from '../features/profile.js';
import { i18n } from '../core/i18n.js';
import { bus } from '../core/eventbus.js';
import { keysFromNsec, generateKeys, skToNsec } from '../core/nostr.js';
import * as dialog from './dialog.js';

const $ = (id) => document.getElementById(id);
let pendingNsec = null; // staged during the "create" step
let masked = false;     // mask state for the create-step key box
let acMasked = false;   // mask state for the connected-step reveal box
let bannerMasked = true;// mask state for the choose-step banner nsec

export const accountModal = {
  init() {
    $('account-modal-close').addEventListener('click', () => this.close());

    $('account-modal').addEventListener('click', (e) => {
      if (e.target.id === 'account-modal') this.close();
    });

    // Step 1 choose
    $('account-modal').querySelectorAll('[data-account-action]').forEach(btn => {
      btn.addEventListener('click', () => this._choose(btn.dataset.accountAction));
    });

    // Step 2 create — backup flow
    $('account-back-to-choose').addEventListener('click', () => this._go('choose'));
    $('account-copy-nsec').addEventListener('click', () => this._copyNsec());
    $('account-download-nsec').addEventListener('click', () => this._downloadNsec());
    $('account-show-toggle').addEventListener('click', (e) => this._toggleMask(e.currentTarget));
    $('account-saved-toggle').addEventListener('change', (e) => {
      $('account-finish-create').disabled = !e.target.checked;
    });
    $('account-finish-create').addEventListener('click', () => this._finishCreate());

    // Step 2 import
    $('account-back-to-choose-2').addEventListener('click', () => this._go('choose'));
    $('account-import-input').addEventListener('input', (e) => {
      const ok = this._validateImport(e.target.value);
      $('account-finish-import').disabled = !ok;          // grey-out Import while the nsec is empty / invalid
    });
    $('account-finish-import').addEventListener('click', () => this._finishImport());

    // Step 0 connected — profile + key actions
    $('ac-copy-npub').addEventListener('click', () => this._copyNpub());
    $('ac-edit-profile').addEventListener('click', () => this._editProfile());
    $('ac-reveal-btn').addEventListener('click', () => this._revealInModal());
    $('ac-disconnect').addEventListener('click', () => this._disconnect());
    $('ac-copy-nsec').addEventListener('click', () => this._copyNsec());
    $('ac-download-nsec').addEventListener('click', () => this._downloadNsec());
    $('ac-show-toggle').addEventListener('click', (e) => this._toggleAcMask(e.currentTarget));

    // Choose-step banner — copy npub/nsec, toggle nsec visibility
    $('ac-banner-copy-npub').addEventListener('click', () => this._bannerCopyNpub());
    $('ac-banner-copy-nsec').addEventListener('click', () => this._bannerCopyNsec());
    $('ac-banner-show-nsec').addEventListener('click', (e) => this._toggleBannerNsec(e.currentTarget));

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
  },

  /**
   * Open the modal. Defaults to the "connected" step when an account is set,
   * otherwise to "choose". An explicit step (e.g. 'choose' from Settings
   * "Set up account…") always wins.
   */
  open(initialStep) {
    pendingNsec = null;
    masked = false;
    acMasked = false;
    $('account-saved-toggle').checked = false;
    $('account-finish-create').disabled = true;
    $('account-import-input').value = '';
    $('account-import-error').classList.add('hidden');
    const step = initialStep || (account.current() ? 'connected' : 'choose');
    this._go(step);
    $('account-modal').classList.remove('hidden');
    $('account-modal').setAttribute('aria-hidden', 'false');
  },

  close() {
    // If the user generated a key but didn't finish backup, give them a
    // serious-but-not-blocking warning before letting them leave with the
    // key still staged (and not yet saved).
    if (pendingNsec) {
      this._warnAbandonBackup();
      return;
    }
    this._hide();
  },

  _hide() {
    $('account-modal').classList.add('hidden');
    $('account-modal').setAttribute('aria-hidden', 'true');
    pendingNsec = null;
    masked = false;
    acMasked = false;
    // Hide the reveal box so it doesn't linger with a secret on screen.
    $('ac-reveal-section')?.classList.add('hidden');
  },

  async _warnAbandonBackup() {
    const ok = await dialog.confirm({
      kind: 'danger',
      destructiveDanger: true,
      title: i18n.t('account.abandonTitle'),
      message: i18n.t('account.abandon'),
      detail: i18n.t('account.abandonDetail'),
      confirmText: i18n.t('account.abandonConfirm'),
      cancelText: i18n.t('account.back'),
    });
    if (ok) {
      pendingNsec = null;
      this._hide();
    }
  },

  _go(step) {
    $('account-modal').querySelectorAll('[data-step]').forEach(s => {
      s.classList.toggle('hidden', s.dataset.step !== step);
    });
    if (step === 'connected') {
      $('account-modal-title').textContent = i18n.t('account.connectedTitle');
      this._renderConnected();
    } else if (step === 'choose') {
      $('account-modal-title').textContent = i18n.t('account.setupTitle');
      this._renderChooseBanner();
    } else if (step === 'create') {
      $('account-modal-title').textContent = i18n.t('account.backupTitle');
    } else if (step === 'import') {
      $('account-modal-title').textContent = i18n.t('account.importTitle');
    }
  },

  /* ---------- Choose-step banner: current account + keys ---------- */

  /**
   * When the choose step opens and the user is already connected, show a
   * banner at the top with their profile + copyable npub/nsec so they can
   * grab their keys without leaving the setup screen. Hidden when not connected.
   */
  _renderChooseBanner() {
    const acc = account.current();
    const banner = $('ac-choose-banner');
    if (!acc) { banner.classList.add('hidden'); return; }
    banner.classList.remove('hidden');

    const p = profile.current();
    const name = (p && (p.displayName || p.name)) || acc.displayName || account.shortNpub(acc.npub || '');
    const picture = p && p.picture;

    const avatar = $('ac-banner-avatar');
    if (picture) {
      avatar.innerHTML = `<img src="${picture}" alt="" onerror="this.parentNode.textContent='${escapeAttr((name||'N').slice(0,1).toUpperCase())}'">`;
    } else {
      avatar.textContent = (name || 'N').slice(0, 1).toUpperCase();
    }
    $('ac-banner-name').textContent = name;
    $('ac-banner-status').textContent = i18n.t('account.connectedReady');

    // Public key (always shown).
    $('ac-banner-npub').textContent = acc.npub || '—';

    // Private key row only for nsec-backed accounts.
    const nsec = account.revealSecret();
    const nsecRow = $('ac-banner-nsec-row');
    if (nsec) {
      nsecRow.classList.remove('hidden');
      // Keep masked by default until the user taps Show.
      $('ac-banner-nsec').textContent = nsec;
      $('ac-banner-nsec').classList.add('masked');
      bannerMasked = true;
      $('ac-banner-show-nsec').textContent = i18n.t('account.show');
    } else {
      nsecRow.classList.add('hidden');
    }
  },

  _toggleBannerNsec(btn) {
    bannerMasked = !bannerMasked;
    $('ac-banner-nsec').classList.toggle('masked', bannerMasked);
    btn.textContent = i18n.t(bannerMasked ? 'account.show' : 'account.hide');
  },

  async _bannerCopyNpub() {
    const npub = account.current()?.npub || '';
    try { await navigator.clipboard.writeText(npub); bus.emit('toast', i18n.t('account.npubCopied')); }
    catch { bus.emit('toast', i18n.t('profile.copyFailed')); }
  },

  async _bannerCopyNsec() {
    const nsec = account.revealSecret();
    if (!nsec) return;
    try { await navigator.clipboard.writeText(nsec); bus.emit('toast', i18n.t('account.copied')); }
    catch { bus.emit('toast', i18n.t('profile.copyFailed')); }
  },

  /* ---------- Step 0: connected — profile + key actions ---------- */

  /** Populate the connected step with the current profile + npub. */
  _renderConnected() {
    const acc = account.current();
    if (!acc) { this._go('choose'); return; }
    const p = profile.current();
    const name = (p && (p.displayName || p.name)) || acc.displayName || account.shortNpub(acc.npub || '');
    const picture = p && p.picture;
    const nip05 = p && p.nip05;
    const verified = !!(p && p.nip05Verified);

    const avatar = $('ac-avatar');
    if (picture) {
      avatar.innerHTML = `<img src="${picture}" alt="" onerror="this.parentNode.textContent='${escapeAttr((name||'N').slice(0,1).toUpperCase())}'">`;
    } else {
      avatar.textContent = (name || 'N').slice(0, 1).toUpperCase();
    }
    $('ac-name').textContent = name;
    const nip05El = $('ac-nip05');
    if (nip05) {
      nip05El.innerHTML = `<span class="nip05-chip ${verified ? 'verified' : ''}">${verified ? '<svg viewBox="0 0 24 24" class="ico"><path d="M20 6L9 17l-5-5"/></svg>' : ''}${escapeHtml(nip05)}</span>`;
    } else { nip05El.innerHTML = ''; }
    $('ac-npub').textContent = acc.npub || '—';
    $('ac-source').textContent = i18n.t('account.source.' + (acc.source || 'npub'));

    // "Reveal private key" only for nsec-backed accounts.
    $('ac-reveal-btn').classList.toggle('hidden', acc.source !== 'nsec');
    $('ac-reveal-section').classList.add('hidden');
    acMasked = false;
    $('ac-show-toggle').textContent = i18n.t('account.hide');
  },

  async _copyNpub() {
    const npub = account.current()?.npub || '';
    try {
      await navigator.clipboard.writeText(npub);
      bus.emit('toast', i18n.t('account.npubCopied'));
    } catch {
      bus.emit('toast', i18n.t('profile.copyFailed'));
    }
  },

  /** Close this modal and open Settings (which has the profile editor). */
  _editProfile() {
    this._hide();
    document.getElementById('settings-btn')?.click();
  },

  /**
   * Reveal the private key inside the modal's styled reveal box (after the
   * warn-confirm gate). The user copies/downloads explicitly via the buttons.
   */
  async _revealInModal() {
    const nsec = account.revealSecret();
    if (!nsec) { bus.emit('toast', i18n.t('account.noBackup')); return; }
    const ok = await dialog.confirm({
      kind: 'warn',
      title: i18n.t('account.backupTitle'),
      message: i18n.t('account.backupReveal'),
      detail: i18n.t('account.backupRevealDetail'),
      confirmText: i18n.t('account.reveal'),
      cancelText: i18n.t('dialog.cancel'),
    });
    if (!ok) return;
    const code = $('ac-reveal-nsec');
    code.textContent = nsec;
    code.classList.remove('masked');
    acMasked = false;
    $('ac-show-toggle').textContent = i18n.t('account.hide');
    $('ac-reveal-section').classList.remove('hidden');
  },

  _toggleAcMask(btn) {
    acMasked = !acMasked;
    $('ac-reveal-nsec').classList.toggle('masked', acMasked);
    btn.textContent = i18n.t(acMasked ? 'account.show' : 'account.hide');
  },

  async _disconnect() {
    const holdsSecret = !!account.revealSecret();
    const acc = account.current();
    const message = holdsSecret && acc?.source === 'nsec'
      ? i18n.t('account.disconnectWarn')
      : i18n.t('settings.accountDisconnect');
    const ok = await dialog.confirm({
      kind: 'danger',
      destructiveDanger: true,
      title: i18n.t('settings.accountDisconnect'),
      message,
      detail: i18n.t('account.disconnectDetail'),
      confirmText: i18n.t('settings.accountDisconnect'),
    });
    if (!ok) return;
    account.disconnect();
    bus.emit('toast', i18n.t('toast.accountDisconnected'));
    this._hide();
  },

  /* ---------- Step 1 → routing ---------- */

  _choose(action) {
    if (action === 'create')        this._startCreate();
    else if (action === 'import')   this._startImport();
    else if (action === 'nip07')    this._startNip07();
  },

  /* ---------- Create flow (with mandatory backup) ---------- */

  async _startCreate() {
    // Generate a fresh key now (instant), then route to the backup step.
    const nsec = skToNsecLive();
    pendingNsec = nsec;
    const codeEl = $('account-generated-nsec');
    codeEl.textContent = nsec;
    codeEl.classList.remove('masked');
    masked = false;
    $('account-show-toggle').textContent = i18n.t('account.hide');
    $('account-saved-toggle').checked = false;
    $('account-finish-create').disabled = true;
    this._go('create');
  },

  _copyNsec() {
    navigator.clipboard?.writeText(pendingNsec || '').catch(() => {});
    bus.emit('toast', i18n.t('account.copied'));
  },

  _downloadNsec() {
    const blob = new Blob([pendingNsec], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bitos-nostr-key-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    bus.emit('toast', i18n.t('account.downloaded'));
  },

  _toggleMask(btn) {
    masked = !masked;
    $('account-generated-nsec').classList.toggle('masked', masked);
    btn.textContent = i18n.t(masked ? 'account.show' : 'account.hide');
  },

  _finishCreate() {
    if (!pendingNsec) return;
    account.connect(pendingNsec); // persist + emit account:changed
    pendingNsec = null;
    this._hide();
    bus.emit('toast', i18n.t('toast.accountConnected'));
  },

  /* ---------- Import flow ---------- */

  _startImport() {
    $('account-import-input').value = '';
    $('account-import-input').focus();
    $('account-import-error').classList.add('hidden');
    $('account-finish-import').disabled = true;             // input is empty → keep Import greyed-out until a valid nsec is pasted
    this._go('import');
  },

  _validateImport(value) {
    const v = value.trim();
    const errEl = $('account-import-error');
    if (!v) {
      errEl.textContent = '';
      errEl.classList.add('hidden');
      return false;                                         // empty input → not yet valid
    }
    try {
      keysFromNsec(v); // throws on bad checksum / wrong prefix
      errEl.textContent = '';
      errEl.classList.add('hidden');
      return true;                                          // valid nsec1
    } catch {
      errEl.textContent = i18n.t('account.importInvalid');
      errEl.classList.remove('hidden');
      return false;                                         // bad checksum / wrong prefix
    }
  },

  async _finishImport() {
    const value = $('account-import-input').value.trim();
    try { keysFromNsec(value); }
    catch {
      $('account-import-error').textContent = i18n.t('account.importInvalid');
      $('account-import-error').classList.remove('hidden');
      return;
    }
    const res = account.connect(value);
    if (!res.ok) {
      $('account-import-error').textContent = i18n.t('account.invalid');
      $('account-import-error').classList.remove('hidden');
      return;
    }
    this._hide();
    bus.emit('toast', i18n.t('toast.accountConnected'));
  },

  /* ---------- NIP-07 flow ---------- */

  async _startNip07() {
    const res = await account.connectNip07();
    if (!res.ok) {
      this._hide();
      bus.emit('toast', i18n.t(res.error));
      return;
    }
    this._hide();
    bus.emit('toast', i18n.t('toast.accountConnected'));
  },
};

function skToNsecLive() {
  const { sk } = generateKeys();
  return skToNsec(sk);
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function escapeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
