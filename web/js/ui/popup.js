/**
 * ui/popup.js
 * Small shared popup menu helper (SRP: positioning + open/close + outside click).
 * Render content + handle item clicks via a callback. Kept generic so both the
 * sort menu and the folder context menu can reuse the same chrome.
 */

const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>';

/** Build the markup for a menu item. */
export function item({ id, label, danger = false, checked = false }) {
  const cls = ['popup-item'];
  if (danger) cls.push('danger');
  const check = checked ? `<span class="check">${CHECK}</span>` : '<span class="check"></span>';
  return `<button type="button" class="${cls.join(' ')}" role="menuitem" data-id="${id}">${check}<span>${label}</span></button>`;
}

/** A thin separator line. */
export function separator() {
  return '<div class="popup-sep" role="separator"></div>';
}

/** Header label (optional). */
export function header(text) {
  return `<div class="popup-head">${text}</div>`;
}

/**
 * Open the shared popup at an anchor position.
 *
 * @param {HTMLElement|string} anchor — element to anchor to (string → #id lookup)
 * @param {Array<string>} bodyHtml — pre-built menu body HTML to inject
 * @param {(id:string)=>void} onPick — called with the data-id of the clicked item
 */
export function open(anchor, bodyHtml, onPick) {
  const el = typeof anchor === 'string' ? document.getElementById(anchor) : anchor;
  const menu = document.getElementById('popup-menu');
  menu.innerHTML = bodyHtml.join('');
  menu.classList.remove('hidden');
  menu.setAttribute('aria-hidden', 'false');

  // Position: align below the anchor on the inline-start side.
  const r = el.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const spacing = 6;
  let left = r.left;
  if (left + mw > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - mw - 8);
  }
  // Prefer opening below; flip above if no room at the bottom.
  let top = r.bottom + spacing;
  if (top + menu.offsetHeight > window.innerHeight - 8) {
    const above = r.top - menu.offsetHeight - spacing;
    if (above > 8) top = above;
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const closer = (e) => {
    // Click inside the menu → route to onPick then close.
    const choice = e.target.closest('.popup-item');
    if (choice) {
      const id = choice.dataset.id;
      cleanup();
      onPick?.(id);
      return;
    }
    // Click on the anchor itself → let the toggle handler deal with it.
    if (e.target === el || el.contains(e.target)) return;
    // Anywhere else → just close.
    cleanup();
  };
  const escClose = (e) => { if (e.key === 'Escape') cleanup(); };

  function cleanup() {
    menu.classList.add('hidden');
    menu.setAttribute('aria-hidden', 'true');
    menu.innerHTML = '';
    document.removeEventListener('click', closer, true);
    document.removeEventListener('keydown', escClose);
    window.removeEventListener('blur', cleanup);
    window.removeEventListener('resize', cleanup);
  }

  // Use capture so we see the click before any handler on the anchor
  // re-toggles the menu open.
  setTimeout(() => document.addEventListener('click', closer, true), 0);
  document.addEventListener('keydown', escClose);
  window.addEventListener('blur', cleanup);
  window.addEventListener('resize', cleanup);
}

/** Is the shared popup currently open? */
export function isOpen() {
  return !document.getElementById('popup-menu').classList.contains('hidden');
}

/** Close any open popup. */
export function close() {
  const menu = document.getElementById('popup-menu');
  menu.classList.add('hidden');
  menu.setAttribute('aria-hidden', 'true');
  menu.innerHTML = '';
}
