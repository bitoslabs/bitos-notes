/**
 * ui/layout.js
 * Owns the show/hide state of the folders sidebar on desktop (SRP: this is the
 * only module that toggles the 3-pane ↔ 2-pane grid).
 *
 * macOS Notes parity: a single sidebar button in the notes-list toolbar toggles
 * the folders pane. The state persists across reloads via store prefs. Mobile is
 * untouched — over there the folders pane is already an overlay driven by the
 * router, so this toggle is desktop-only (see .desktop-only in app.css).
 */

import { store } from '../core/store.js';
import { i18n } from '../core/i18n.js';
import { bus } from '../core/eventbus.js';

const $ = (id) => document.getElementById(id);

export const layout = {
  init() {
    $('toggle-folders-btn').addEventListener('click', () => this.toggle());

    // Crossing the responsive breakpoint must not strand the desktop toggle in
    // a "hidden" state that does nothing on mobile — re-apply per mode.
    bus.on('layout:changed', (mode) => this.apply(mode === 'mobile' ? false : this._hidden));

    // Keep the button's tooltip in sync with the active locale.
    bus.on('locale:changed', () => this._syncTitle());

    // Restore the last session's preference (desktop only — on mobile the
    // folders pane is already an overlay, so the toggle is a no-op there).
    const saved = !!store.getPrefs().sidebarHidden;
    this.apply(window.innerWidth < 860 ? false : saved);
  },

  /** Flip the sidebar visibility and persist the new state. */
  toggle() {
    this.apply(!this._hidden);
    store.setPrefs({ sidebarHidden: this._hidden });
  },

  /** Apply a visibility state to the DOM (no persistence — call setPrefs too). */
  apply(hidden) {
    this._hidden = !!hidden;
    const app = document.getElementById('app');
    if (app) app.classList.toggle('hide-folders', this._hidden);
    const btn = $('toggle-folders-btn');
    if (btn) btn.classList.toggle('is-collapsed', this._hidden);
    this._syncTitle();
  },

  /** Reflect the current state in the button's title + aria-label. */
  _syncTitle() {
    const btn = $('toggle-folders-btn');
    if (!btn) return;
    const txt = i18n.t(this._hidden ? 'nav.showSidebar' : 'nav.hideSidebar');
    btn.setAttribute('title', txt);
    btn.setAttribute('aria-label', txt);
  },
};
