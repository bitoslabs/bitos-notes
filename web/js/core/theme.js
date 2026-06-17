/**
 * core/theme.js
 * Theme manager (SRP: only this module decides the active theme + accent color).
 *
 * Modes:
 *   'light'  → always light
 *   'dark'   → always dark
 *   'system' → follow prefers-color-scheme (and react to OS changes)
 *
 * The resolved theme is written to <body data-theme="…"> so CSS vars apply.
 * Listens to OS changes while in 'system' mode so it stays in sync.
 *
 * Accent colour: an inline override on :root that re-points --notes-blue
 * (and derives matching alpha variants for glow / soft backgrounds) so the
 * whole UI re-skins instantly without rewriting CSS rules.
 */

import { bus } from './eventbus.js';
import { store } from './store.js';

const MQ = window.matchMedia('(prefers-color-scheme: dark)');

/** Curated swatch palette — Apple-ish system colors + the brand default. */
const ACCENTS = [
  { id: 'blue',    name: 'Blue',    hex: '#007AFF' },   // Apple systemBlue (default)
  { id: 'purple',  name: 'Purple',  hex: '#AF52DE' },   // systemPurple
  { id: 'pink',    name: 'Pink',    hex: '#FF2D55' },   // systemPink
  { id: 'red',     name: 'Red',     hex: '#FF3B30' },   // systemRed
  { id: 'orange',  name: 'Orange',  hex: '#FF9500' },   // systemOrange
  { id: 'green',   name: 'Green',   hex: '#34C759' },   // systemGreen
  { id: 'teal',    name: 'Teal',    hex: '#30B0C7' },   // systemTeal
  { id: 'indigo',  name: 'Indigo',  hex: '#5856D6' },   // systemIndigo
];

function systemIsDark() { return MQ.matches; }
function resolve(mode) { return mode === 'dark' ? 'dark' : mode === 'light' ? 'light' : (systemIsDark() ? 'dark' : 'light'); }

/** Convert "#RRGGBB" to "r, g, b" (for building rgba() alpha variants). */
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '0, 122, 255';
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

export const theme = {
  get mode() { return store.getPrefs().theme || 'system'; },
  get resolved() { return document.body.dataset.theme; },

  /** Accent preset list (for the settings UI to render swatches). */
  get accents() { return ACCENTS; },

  /** Current accent id (e.g. 'purple'). Falls back to 'blue' (brand default). */
  get accent() {
    const saved = store.getPrefs().accent;
    return ACCENTS.some(a => a.id === saved) ? saved : 'blue';
  },

  /** Hex of the current accent. Convenience for JS consumers (e.g. avatar gradient). */
  get accentHex() {
    const a = ACCENTS.find(x => x.id === this.accent) || ACCENTS[0];
    return a.hex;
  },

  /** Apply the stored mode + accent on boot. Returns the resolved theme. */
  init() {
    MQ.addEventListener('change', () => {
      if (this.mode === 'system') this._apply();
    });
    this._applyAccent();
    return this._apply();
  },

  /** Switch mode ('light'|'dark'|'system') and apply. */
  setMode(mode) {
    if (!['light', 'dark', 'system'].includes(mode)) return;
    store.setPrefs({ theme: mode });
    this._apply();
    bus.emit('theme:changed', { mode, resolved: this.resolved });
  },

  /** Switch accent preset by id. Persists + applies + emits. */
  setAccent(id) {
    const preset = ACCENTS.find(a => a.id === id);
    if (!preset) return;
    store.setPrefs({ accent: id });
    this._applyAccent(preset.hex);
    bus.emit('theme:changed', { accent: id, accentHex: preset.hex });
  },

  _apply() {
    const resolved = resolve(this.mode);
    document.body.dataset.theme = resolved;
    document.querySelector('meta[name="theme-color"][media*="light"]')?.setAttribute('content', resolved === 'light' ? '#ffffff' : '#1c1c1e');
    return resolved;
  },

  /** Override the --notes-blue family on :root so the whole app re-skins. */
  _applyAccent(hex) {
    const h = hex || this.accentHex;
    const rgb = hexToRgb(h);
    const root = document.documentElement;
    root.style.setProperty('--notes-blue', h);
    // Alpha tints used by focus glows, soft backgrounds, and the relay flag.
    root.style.setProperty('--notes-blue-rgb', rgb);
    root.style.setProperty('--notes-blue-soft', `rgba(${rgb}, 0.12)`);
    root.style.setProperty('--notes-blue-glow', `rgba(${rgb}, 0.15)`);
  },
};
