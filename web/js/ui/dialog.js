/**
 * ui/dialog.js
 * Promise-based confirm / alert / prompt that matches the app's modal chrome
 * (the same look-and-feel as the Settings modal). Replaces the native window
 * confirm()/prompt() so the whole app stays consistent and works on platforms
 * where the native dialog is missing (PWAs, headless, iOS Safari quirks).
 *
 * Usage:
 *   import * as dialog from './ui/dialog.js';
 *
 *   if (!(await dialog.confirm({ message: 'Delete this note?', danger: true }))) return;
 *   const name = await dialog.prompt({ message: 'Folder name:', value: 'New Folder' });
 *   await dialog.alert({ message: 'Backup your key!', title: 'Important' });
 *
 * All methods return null/undefined when cancelled.
 */

import { i18n } from '../core/i18n.js';

const t = (k, v) => i18n.t(k, v);

const ICONS = {
  danger: '<svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  warn:   '<svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  info:   '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
};

/**
 * Build + render a dialog. Returns a promise that resolves with the result.
 *
 * @param {object} opts
 * @param {string} [opts.title]   — small uppercase header above the message
 * @param {string}  opts.message  — main body text
 * @param {string} [opts.detail]  — secondary muted line
 * @param {string} [opts.kind]    — 'danger' | 'warn' | 'info' (controls icon + danger styling)
 * @param {string} [opts.confirmText]  — confirm button label
 * @param {string} [opts.cancelText]   — cancel button label (omit to hide)
 * @param {boolean}[opts.destructiveDanger] — force red confirm button
 * @param {'confirm'|'alert'|'prompt'} [opts.mode='confirm']
 * @param {string} [opts.value]    — initial prompt input value
 * @param {string} [opts.placeholder]
 * @param {string} [opts.inputType='text']
 * @param {(value:string)=>string|null} [opts.validate] — return error string or null
 * @param {boolean}[opts.requiresText] — for confirm mode: require typing `opts.requireMatch` text in a box to enable the confirm button
 * @param {string} [opts.requireMatch]
 */
function create(opts) {
  return new Promise((resolve) => {
    const backdrop = document.getElementById('dialog-backdrop');
    const box = document.getElementById('dialog');
    const iconWrap = document.getElementById('dialog-icon');
    const title = document.getElementById('dialog-title');
    const message = document.getElementById('dialog-message');
    const detail = document.getElementById('dialog-detail');
    const inputWrap = document.getElementById('dialog-input-wrap');
    const input = document.getElementById('dialog-input');
    const inputError = document.getElementById('dialog-input-error');
    const actions = document.getElementById('dialog-actions');
    const okBtn = document.getElementById('dialog-ok');
    const cancelBtn = document.getElementById('dialog-cancel');

    const mode = opts.mode || 'confirm';

    // Header / icon
    const kind = opts.kind || (opts.destructiveDanger ? 'danger' : 'info');
    iconWrap.innerHTML = ICONS[kind] || ICONS.info;
    iconWrap.className = `dialog-icon kind-${kind} ${opts.iconless ? 'hidden' : ''}`;

    if (opts.title) {
      title.textContent = opts.title;
      title.classList.remove('hidden');
    } else {
      title.classList.add('hidden');
    }

    message.textContent = opts.message || '';
    message.classList.toggle('hidden', !opts.message);

    detail.textContent = opts.detail || '';
    detail.classList.toggle('hidden', !opts.detail);

    // Cancel button visibility
    const hasCancel = mode !== 'alert' && opts.cancelText !== null;
    cancelBtn.classList.toggle('hidden', !hasCancel);
    cancelBtn.textContent = opts.cancelText || t('dialog.cancel');

    // Confirm button
    const dangerStyle = !!opts.destructiveDanger || kind === 'danger';
    okBtn.className = `btn-primary ${dangerStyle ? 'danger' : ''}`;
    okBtn.textContent = opts.confirmText || (mode === 'prompt' ? t('dialog.ok') : t('dialog.confirm'));

    // Input (prompt or text-required confirm)
    const needsInput = mode === 'prompt' || !!opts.requiresText;
    inputWrap.classList.toggle('hidden', !needsInput);
    inputError.textContent = '';
    inputError.classList.add('hidden');
    if (needsInput) {
      input.type = opts.inputType || 'text';
      input.value = opts.value || '';
      input.placeholder = opts.placeholder || (opts.requiresText ? opts.requireMatch : '');
    }

    let resultValue;
    const runValidate = () => {
      if (!needsInput) return null;
      const v = input.value;
      if (opts.requiresText && v.trim() !== opts.requireMatch) {
        return t('dialog.noMatch');
      }
      if (typeof opts.validate === 'function') {
        const err = opts.validate(v);
        if (err) return err;
      }
      return null;
    };
    const syncValidity = () => {
      const err = runValidate();
      const emptyPrompt = mode === 'prompt' && !input.value.trim();
      inputError.textContent = err || '';
      inputError.classList.toggle('hidden', !err);
      okBtn.disabled = !!err || emptyPrompt;
    };
    if (needsInput) {
      input.oninput = syncValidity;
      syncValidity();
    } else {
      okBtn.disabled = false;
    }

    // Focus management (after the dialog becomes visible).
    requestAnimationFrame(() => {
      if (needsInput) { input.focus(); input.select?.(); }
      else if (hasCancel) cancelBtn.focus();
      else okBtn.focus();
    });

    function close(value) {
      cleanup();
      resolve(value);
    }
    function onOk() {
      if (okBtn.disabled) return;
      if (mode === 'prompt') close(input.value);
      else close(true);
    }
    function onCancel() { close(mode === 'prompt' ? null : false); }
    function onKeydown(e) {
      if (e.key === 'Escape' && hasCancel) { e.preventDefault(); onCancel(); }
      else if (e.key === 'Enter' && (mode === 'prompt' || needsInput)) {
        e.preventDefault();
        if (!okBtn.disabled) onOk();
      }
    }
    function onBackdrop(e) { if (e.target === backdrop && hasCancel) onCancel(); }

    function cleanup() {
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKeydown);
      input.oninput = null;
      backdrop.classList.add('hidden');
      backdrop.setAttribute('aria-hidden', 'true');
      // Restore focus to whatever opened the dialog if tracked.
      lastFocus?.focus?.();
    }

    let lastFocus = document.activeElement;

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    backdrop.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKeydown);

    backdrop.classList.remove('hidden');
    backdrop.setAttribute('aria-hidden', 'false');
  });
}

/* ---- Public API ---- */

export function confirm(opts) { return create({ ...opts, mode: 'confirm' }); }
export function alert(opts)   { return create({ ...opts, mode: 'alert' }); }
export function prompt(opts)  { return create({ ...opts, mode: 'prompt' }); }

/** A confirm that requires typing a specific phrase (dramatic destructive actions). */
export function confirmTyped(opts) {
  return create({ ...opts, mode: 'confirm', requiresText: true });
}
