/**
 * features/account.js
 * Nostr account manager (SRP: account state + NIP-07 connect/disconnect).
 *
 * This is the browser integration point for a real BitOS Notes Nostr app:
 * - `npub`: public identity, safe to store/display.
 * - `nsec`: private key. Do not use in production unless stored in a secure
 *   native wrapper / extension / NIP-07 provider.
 * - NIP-07 (`window.nostr`): best web UX because the extension owns the key.
 */

import { store } from '../core/store.js';
import { bus } from '../core/eventbus.js';

const NSEC_PREFIX = 'nsec1';
const NPUB_PREFIX = 'npub1';

export const account = {
  /** Current account from localStorage. */
  current() {
    const saved = store.getAccount();
    if (!saved?.npub && !saved?.nsec && !saved?.rawPubkey) return null;
    const display = saved.npub || saved.nsec || ('npub1' + saved.rawPubkey);
    return { ...saved, displayName: saved.displayName || this.shortNpub(display), connected: true };
  },

  /** Connect with NIP-07 extension, npub, or nsec. Returns {ok, account?, error}. */
  async connect(secretOrMethod) {
    const value = (secretOrMethod || '').trim();

    if (value === 'nip07') {
      return this.connectNip07();
    }

    if (value.startsWith(NPUB_PREFIX)) {
      store.setAccount({ npub: value, displayName: this.shortNpub(value), source: 'npub' });
      bus.emit('account:changed');
      return { ok: true, account: this.current() };
    }

    if (value.startsWith(NSEC_PREFIX)) {
      // UI-complete fallback: store private key only for local testing.
      // A real release should replace this with NIP-07/native secure storage.
      store.setAccount({ nsec: value, displayName: this.shortNpub(value), source: 'nsec' });
      bus.emit('account:changed');
      return { ok: true, account: this.current() };
    }

    return { ok: false, error: 'account.invalid' };
  },

  /** Connect through a NIP-07 provider such as Alby/Amethyst browser extension. */
  async connectNip07() {
    const provider = window.nostr;
    if (!provider?.getPublicKey) return { ok: false, error: 'account.nip07Missing' };

    try {
      const pubkey = await provider.getPublicKey();
      const safeDisplay = 'npub1' + pubkey;
      store.setAccount({ rawPubkey: pubkey, displayName: this.shortNpub(safeDisplay), source: 'nip07' });
      bus.emit('account:changed');
      return { ok: true, account: this.current() };
    } catch {
      return { ok: false, error: 'account.nip07Failed' };
    }
  },

  /** Remove the stored account. */
  disconnect() {
    store.setAccount(null);
    bus.emit('account:changed');
  },

  shortNpub(value) {
    return value ? `${value.slice(0, 12)}…${value.slice(-6)}` : '';
  },
};
