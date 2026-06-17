/**
 * core/i18n.js
 * Internationalization layer (SRP: only this module owns translations + DOM binding).
 *
 * Locale files are ES modules (locales/*.js) imported statically at the top level.
 * No fetch(), no CORS issues, works on file://, works offline instantly.
 * The browser only downloads the modules it needs (tree-shakeable in bundlers).
 *
 * Usage in HTML:
 *   <div data-i18n="folders.title"></div>                       → textContent
 *   <input data-i18n-placeholder="folders.search" />           → placeholder attr
 *   <button data-i18n-title="editor.bold" title="x">B</button>  → title attr
 *
 * In JS:
 *   import { i18n } from '../core/i18n.js';
 *   alert(i18n.t('editor.delete'));
 *
 * Keys are flat strings with dots as visual grouping. Missing keys fall back
 * to English, then to the raw key itself.
 */

import { bus } from './eventbus.js';
import { store } from './store.js';

// ---- Static imports — no runtime fetch, no CORS, works on file:// ----
import enDict from '../../locales/en.js';
import frDict from '../../locales/fr.js';
import esDict from '../../locales/es.js';
import arDict from '../../locales/ar.js';
import loDict from '../../locales/lo.js';
import thDict from '../../locales/th.js';

const SUPPORTED = {
  en: { name: 'English',  native: 'English',  rtl: false, dict: enDict },
  fr: { name: 'Français', native: 'Français', rtl: false, dict: frDict },
  es: { name: 'Español',  native: 'Español',  rtl: false, dict: esDict },
  ar: { name: 'العربية',  native: 'العربية',  rtl: true,  dict: arDict },
  lo: { name: 'Lao',      native: 'ລາວ',      rtl: false, dict: loDict },
  th: { name: 'Thai',     native: 'ไทย',      rtl: false, dict: thDict },
};

let current = 'en';
let dict = enDict;

/**
 * Resolve a translation key against a flat-keyed dict.
 * The locale files use literal dotted keys ("app.title"), so the primary
 * lookup is a direct property access. A nested-path walk is kept as fallback
 * for any future nested-structure translations.
 */
function resolveKey(obj, path) {
  if (!obj) return undefined;
  if (obj[path] !== undefined) return obj[path];        // flat key: "app.title"
  // nested fallback: walk "app" → "title"
  return path.split('.').reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);
}

export const i18n = {
  get supported() { return SUPPORTED; },
  get locale() { return current; },
  get rtl() { return SUPPORTED[current]?.rtl ?? false; },
  get dict() { return dict; },

  /** Translate a key with optional {var} interpolation. */
  t(key, vars) {
    let str = resolveKey(dict, key);
    if (str === undefined) str = resolveKey(enDict, key);  // English fallback
    if (str === undefined) return key;                      // last resort: show the key
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
      }
    }
    return str;
  },

  /** Switch locale, persist, and re-apply to the whole document. */
  setLocale(lang) {
    if (!SUPPORTED[lang]) lang = 'en';
    current = lang;
    dict = SUPPORTED[lang].dict;
    store.setPrefs({ lang });
    this.applyToDOM(document);
    document.documentElement.lang = lang;
    document.documentElement.dir = SUPPORTED[lang].rtl ? 'rtl' : 'ltr';
    bus.emit('locale:changed', lang);
  },

  /** Walk an element subtree and apply all data-i18n* attributes. */
  applyToDOM(root = document) {
    root.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = this.t(el.dataset.i18n);
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.setAttribute('placeholder', this.t(el.dataset.i18nPlaceholder));
    });
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.setAttribute('title', this.t(el.dataset.i18nTitle));
    });
  },

  /** Detect initial locale: saved pref → browser → default. */
  detect() {
    const saved = store.getPrefs().lang;
    if (saved && SUPPORTED[saved]) return saved;
    const browser = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return SUPPORTED[browser] ? browser : 'en';
  },
};
