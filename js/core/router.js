/**
 * core/router.js
 * Responsive pane navigation (SRP: only this module owns layout state).
 *
 * Desktop (≥860px): 3 panes always visible side-by-side. No nav state needed.
 * Mobile (<860px):  iOS-style stack — Folders → List → Editor.
 *   The active level is reflected via <body data-view="folders|list|editor">,
 *   which the CSS uses to slide the right panes in/out.
 */

import { bus } from './eventbus.js';

const BREAKPOINT = 860;
const app = () => document.getElementById('app');

function isMobile() { return window.innerWidth < BREAKPOINT; }

export const router = {
  /** 'desktop' or 'mobile' — which layout is active. */
  get mode() { return isMobile() ? 'mobile' : 'desktop'; },

  /** Current mobile view: 'folders' | 'list' | 'editor'. */
  get view() { return app().dataset.view || 'folders'; },

  init() {
    window.addEventListener('resize', () => {
      // When crossing the breakpoint, normalise state so nothing is stuck off-screen.
      const prev = app().dataset.lastMode;
      const now = this.mode;
      if (prev && prev !== now) this.normalize();
      app().dataset.lastMode = now;
      bus.emit('layout:changed', now);
    });
    this.normalize();
  },

  /** Go to a mobile stack level. No-op on desktop. */
  go(view) {
    if (this.mode === 'desktop') return;
    if (!['folders', 'list', 'editor'].includes(view)) return;
    app().dataset.view = view;
    bus.emit('view:changed', { view, mode: this.mode });
  },

  /** Smart back: editor → list → folders. */
  back() {
    if (this.mode !== 'mobile') return;
    const next = this.view === 'editor' ? 'list' : 'folders';
    this.go(next);
  },

  /** Make sure visible state matches the layout. */
  normalize() {
    if (this.mode === 'desktop') {
      delete app().dataset.view;
    } else if (!app().dataset.view) {
      app().dataset.view = 'folders';
    }
    app().dataset.lastMode = this.mode;
    bus.emit('view:changed', { view: this.view, mode: this.mode });
  },
};
