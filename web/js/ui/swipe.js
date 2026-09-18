/**
 * ui/swipe.js
 * Edge-swipe-to-go-back for mobile (SRP: this is the only module that owns the
 * touch pop gesture). An iOS-style rightward swipe from the left edge pops one
 * level of the mobile stack: editor → list → folders.
 *
 * Safety rails so it never fights other interactions:
 *   - desktop: disabled (router.mode !== 'mobile')
 *   - root screen: no-op (can't go back from Folders)
 *   - drawing active: skipped (let the canvas own the pointers)
 *   - any overlay open: skipped (modals/dialogs/popups)
 *   - vertical-dominant moves: bailed early so lists/editor keep scrolling
 *
 * The pane follows the finger while dragging (native feel), then either commits
 * the navigation or springs back — both via the existing [data-view] CSS, so we
 * only nudge transform inline during the active drag.
 */

import { router } from '../core/router.js';

const EDGE = 30;        // px from the left edge where a back-swipe may begin
const MIN_TRAVEL = 70;  // px of rightward travel required to commit the back nav
const TARGETS = ['#pane-list', '#pane-editor'];

export const swipe = {
  init() {
    TARGETS.forEach((sel) => {
      const el = document.querySelector(sel);
      if (el) this._attach(el);
    });
  },

  _attach(el) {
    let startX = 0, startY = 0;
    let active = false;       // pointer is down from the edge
    let decided = false;      // we've classified horizontal vs vertical
    let horizontal = false;   // it's a back-swipe (not a scroll)
    let baseTx = 0;           // pane's CSS transform X at gesture start

    const gestureEnabled = () =>
      router.mode === 'mobile'
      && router.view !== 'folders'
      && !document.body.classList.contains('draw-active')
      && !this._overlayOpen();

    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;     // mouse-only devices don't need this
      if (!gestureEnabled()) return;
      if (e.clientX > EDGE) return;              // must start at the left edge
      // Never compete with the drawing canvas (it owns its own pointers) or
      // with tappable controls at the screen edge.
      if (e.target.closest?.('.shape-block, .draw-tools, button, a, input, textarea, select')) return;
      startX = e.clientX;
      startY = e.clientY;
      active = true;
      decided = false;
      horizontal = false;
      baseTx = this._readTx(el);
    });

    el.addEventListener('pointermove', (e) => {
      if (!active) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      // Wait for enough movement before deciding, so a plain tap does nothing.
      if (!decided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        decided = true;
        horizontal = dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.4;
        if (horizontal) {
          el.style.transition = 'none';          // follow the finger 1:1
          el.style.willChange = 'transform';
          el.setPointerCapture?.(e.pointerId);
        } else {
          active = false;                        // vertical scroll — let it pan
          return;
        }
      }
      if (!horizontal) return;
      // Only allow rightward travel (clamped ≥ 0); never push the pane left.
      const moved = Math.max(0, dx);
      el.style.transform = `translateX(${baseTx + moved}px)`;
    });

    const finish = (e) => {
      if (!active) return;
      const wasHorizontal = horizontal;
      active = false;
      decided = false;
      horizontal = false;
      el.style.transition = '';
      el.style.willChange = '';
      if (!wasHorizontal) return;
      const dx = (e.clientX - startX) || 0;
      // Hand transform control back to the [data-view] CSS, then navigate if
      // the user dragged far enough. The CSS transition animates the snap.
      el.style.transform = '';
      if (dx >= MIN_TRAVEL) router.back();
    };

    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
  },

  /** Read the pane's current translateX from its computed transform matrix. */
  _readTx(el) {
    const m = getComputedStyle(el).transform;
    if (!m || m === 'none') return 0;
    const mt = m.match(/matrix(?:3d)?\(([^)]+)\)/);
    if (!mt) return 0;
    const parts = mt[1].split(',').map(parseFloat);
    // matrix(a,b,c,d,tx,ty) → tx is parts[4]; matrix3d → parts[12].
    return parts.length === 16 ? (parts[12] || 0) : (parts[4] || 0);
  },

  /** Is any full-screen overlay currently open? (don't swipe behind a sheet) */
  _overlayOpen() {
    return ['settings-modal', 'account-modal', 'dialog-backdrop', 'popup-menu']
      .some((id) => {
        const el = document.getElementById(id);
        return !!el && !el.classList.contains('hidden');
      });
  },
};
