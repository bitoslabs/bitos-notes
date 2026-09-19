/**
 * core/fonts.js
 * Locale-specific webfont loading (SRP: this module owns font resources).
 *
 * The Lao UI needs a Lao-script typeface, but shipping it to every locale
 * would cost a third-party request + font download for users who never see
 * Lao. So the stylesheet is injected on demand and only while the active
 * locale is `lo`. The CSS then opts into the family via [lang="lo"].
 */

import { i18n } from './i18n.js';
import { bus } from './eventbus.js';

const LAO_ORIGIN = 'https://fonts.mts.la';
const LAO_FONT_HREF = `${LAO_ORIGIN}/fonts/chanthavong/chanthavong.css`;
const LAO_LINK_ID = 'font-lao';
const PRECONNECT_ID = 'font-lao-preconnect';

/** Warm up DNS/TLS for the font host once, before the cross-origin fetch. */
function ensurePreconnect() {
  if (document.getElementById(PRECONNECT_ID)) return;
  const link = document.createElement('link');
  link.id = PRECONNECT_ID;
  link.rel = 'preconnect';
  link.href = LAO_ORIGIN;
  link.crossOrigin = 'anonymous';
  document.head.appendChild(link);
}

/** Inject the @font-face stylesheet once (idempotent). */
function ensureLaoStylesheet() {
  if (document.getElementById(LAO_LINK_ID)) return;
  const link = document.createElement('link');
  link.id = LAO_LINK_ID;
  link.rel = 'stylesheet';
  link.href = LAO_FONT_HREF;
  document.head.appendChild(link);
}

export const fonts = {
  /** Call once at boot, after i18n.setLocale(). */
  init() {
    this.apply(i18n.locale);
    bus.on('locale:changed', (lang) => this.apply(lang));
  },

  /** Load the Lao face when the Lao locale is active. */
  apply(lang) {
    if (lang !== 'lo') return;
    ensurePreconnect();
    ensureLaoStylesheet();
  },
};
