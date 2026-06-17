/**
 * core/theme.js
 * Theme manager (SRP: only this module decides the active theme).
 *
 * Modes:
 *   'light'  → always light
 *   'dark'   → always dark
 *   'system' → follow prefers-color-scheme (and react to OS changes)
 *
 * The resolved theme is written to <body data-theme="…"> so CSS vars apply.
 * Listens to OS changes while in 'system' mode so it stays in sync.
 */

import { bus } from './eventbus.js';
import { store } from './store.js';

const MQ = window.matchMedia('(prefers-color-scheme: dark)');

function systemIsDark() { return MQ.matches; }
function resolve(mode) { return mode === 'dark' ? 'dark' : mode === 'light' ? 'light' : (systemIsDark() ? 'dark' : 'light'); }

export const theme = {
  get mode() { return store.getPrefs().theme || 'system'; },
  get resolved() { return document.body.dataset.theme; },

  /** Apply the stored mode on boot. Returns the resolved theme. */
  init() {
    MQ.addEventListener('change', () => {
      if (this.mode === 'system') this._apply();
    });
    return this._apply();
  },

  /** Switch mode ('light'|'dark'|'system') and apply. */
  setMode(mode) {
    if (!['light', 'dark', 'system'].includes(mode)) return;
    store.setPrefs({ theme: mode });
    this._apply();
    bus.emit('theme:changed', { mode, resolved: this.resolved });
  },

  _apply() {
    const resolved = resolve(this.mode);
    document.body.dataset.theme = resolved;
    document.querySelector('meta[name="theme-color"][media*="light"]')?.setAttribute('content', resolved === 'light' ? '#ffffff' : '#1c1c1e');
    return resolved;
  },
};
