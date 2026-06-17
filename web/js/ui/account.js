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
import { i18n } from '../core/i18n.js';
import { bus } from '../core/eventbus.js';
import { keysFromNsec, generateKeys, skToNsec } from '../core/nostr.js';
import * as dialog from './dialog.js';

const $ = (id) => document.getElementById(id);
let pendingNsec = null; // staged during the "create" step
let masked = false;

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

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
  },

  open(initialStep = 'choose') {
    pendingNsec = null;
    $('account-saved-toggle').checked = false;
    $('account-finish-create').disabled = true;
    $('account-import-input').value = '';
    $('account-import-error').classList.add('hidden');
    this._go(initialStep);
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
    if (step === 'choose') {
      $('account-modal-title').textContent = i18n.t('account.setupTitle');
    } else if (step === 'create') {
      $('account-modal-title').textContent = i18n.t('account.backupTitle');
    } else if (step === 'import') {
      $('account-modal-title').textContent = i18n.t('account.importTitle');
    }
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
