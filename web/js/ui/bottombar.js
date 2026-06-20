/**
 * ui/bottombar.js
 * Mobile bottom app bar (SRP: wires the persistent thumb-reach nav + the
 * editor format toggle). Hidden on desktop via CSS (.mobile-only) and hidden
 * when the soft keyboard is open so it never floats above the keys.
 *
 * The bar mirrors existing actions rather than duplicating logic:
 *   folders  → router.go('folders')
 *   search   → focus the folders-pane search box + navigate there
 *   new      → bus 'quick:create' (same path as the + in the list header)
 *   settings → settings.open()
 *
 * Editor 'Aa' toggle (#format-toggle) shows/hides the formatting toolbar on
 * mobile (the toolbar is always-on only on desktop).
 */

import { router } from '../core/router.js';
import { settings } from './settings.js';
import { bus } from '../core/eventbus.js';

const $ = (id) => document.getElementById(id);

export const bottomBar = {
  init() {
    const bar = $('bottom-bar');
    if (!bar) return;

    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-bb]');
      if (!btn) return;
      e.preventDefault();
      this._action(btn.dataset.bb);
    });

    // Editor format toggle (Aa) — mobile only.
    $('format-toggle')?.addEventListener('click', () => this.toggleFormat());

    // Keep the active destination highlighted as the view changes.
    bus.on('view:changed', ({ view }) => {
      this._syncActive(view);
      if (view !== 'editor') this._setFormat(false);
    });
    this._syncActive(router.view);

    // Hide the bar while the soft keyboard is up so it doesn't sit over the
    // keys. visualViewport covers modern mobile browsers; fall back to a resize
    // heuristic on those without it.
    this._watchKeyboard();
  },

  /** Route a bottom-bar action by id. */
  _action(id) {
    switch (id) {
      case 'folders':
        router.go('folders');
        break;
      case 'notes':
        // Jump straight to the notes list for the active/last folder.
        router.go('list');
        break;
      case 'search':
        // Search lives in the folders pane; reveal it and focus the field.
        router.go('folders');
        setTimeout(() => $('search-input')?.focus(), 60);
        break;
      case 'new':
        bus.emit('quick:create');
        break;
      case 'settings':
        settings.open();
        break;
    }
  },

  /** Show / hide the editor formatting toolbar on mobile. */
  toggleFormat() {
    const tb = $('toolbar');
    if (!tb) return;
    this._setFormat(!tb.classList.contains('mobile-open'));
  },

  _setFormat(open) {
    const tb = $('toolbar');
    const btn = $('format-toggle');
    if (!tb || !btn) return;
    tb.classList.toggle('mobile-open', open);
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-pressed', String(open));
  },

  /** Highlight the bottom button matching the current mobile view. */
  _syncActive(view) {
    const bar = $('bottom-bar');
    if (!bar) return;
    // Map the mobile view to a bottom-bar button. 'editor' has no dedicated
    // destination, so nothing is highlighted there (the FAB created the note).
    const map = { folders: 'folders', list: 'notes' };
    const active = map[view];
    bar.querySelectorAll('[data-bb]').forEach((b) => {
      // Never highlight the FAB — it's an action, not a destination.
      if (b.classList.contains('bb-fab')) return;
      b.classList.toggle('active', b.dataset.bb === active);
    });
  },

  /** Hide the bar while the on-screen keyboard is open. */
  _watchKeyboard() {
    const bar = $('bottom-bar');
    if (!bar) return;
    const isEditableFocused = () => {
      const a = document.activeElement;
      return !!a && (
        a.matches?.('input, textarea, [contenteditable="true"]') ||
        a.closest?.('[contenteditable="true"]')
      );
    };
    if (window.visualViewport) {
      let baseline = window.visualViewport.height;
      const update = () => {
        // Only treat viewport shrink as keyboard-driven when an editable field
        // is actually focused. Mobile browser chrome can change visualViewport
        // height too, and we do not want to hide the bar for that.
        const focused = isEditableFocused();
        if (!focused) baseline = Math.max(baseline, window.visualViewport.height);
        const keyboardLike = focused && window.visualViewport.height < baseline - 120;
        bar.classList.toggle('kb-open', keyboardLike);
        document.documentElement.classList.toggle('keyboard-open', keyboardLike);
      };
      window.visualViewport.addEventListener('resize', update);
      window.visualViewport.addEventListener('scroll', update);
      window.addEventListener('focusin', update);
      window.addEventListener('focusout', () => setTimeout(update, 100));
      update();
      return;
    }
    // Fallback: two sizes that differ by >120px ⇒ keyboard.
    let h = window.innerHeight;
    window.addEventListener('resize', () => {
      const next = window.innerHeight;
      const keyboardLike = isEditableFocused() && next < h - 120;
      bar.classList.toggle('kb-open', keyboardLike);
      document.documentElement.classList.toggle('keyboard-open', keyboardLike);
      if (next > h) h = next;
    });
  },
};
