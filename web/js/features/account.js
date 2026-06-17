/**
 * features/account.js
 * Nostr account manager (SRP: account state + key handling).
 *
 * Nostr identity is just a key pair — no email, no signup. The private key
 * (`nsec1…`) IS the account. We support three ways to obtain one:
 *   1. generate()    → produce a fresh, random nsec locally
 *   2. connect(nsec) → import an existing key the user already owns
 *   3. connectNip07()→ defer key custody to a NIP-07 wallet (Alby/nos2x/etc.)
 *
 * Stored shape (in localStorage via store.setAccount):
 *   { nsec?, npub?, rawPubkey?, displayName, source, createdAt? }
 *
 * `source` is one of: 'nsec' | 'nip07' | 'npub' (npub-only is read-only identity).
 */

import { store } from '../core/store.js';
import { bus } from '../core/eventbus.js';
import {
  generateKeys, keysFromNsec, pkToNpub, npubToPk,
  skToNsec, toHex,
} from '../core/nostr.js';

const NSEC_PREFIX = 'nsec1';
const NPUB_PREFIX = 'npub1';

export const account = {
  /** Current account from localStorage. */
  current() {
    const saved = store.getAccount();
    if (!saved?.npub && !saved?.nsec && !saved?.rawPubkey) return null;
    // Prefer an npub we can derive. For nsec sources we always have one.
    let npub = saved.npub;
    if (!npub && saved.nsec) {
      try { npub = pkToNpub(keysFromNsec(saved.nsec).pk); } catch {}
    } else if (!npub && saved.rawPubkey) {
      try { npub = pkToNpub(fromHex(saved.rawPubkey)); } catch {}
    }
    const display = saved.displayName || (npub ? this.shortNpub(npub) : '');
    return { ...saved, npub, displayName: display, connected: true };
  },

  /** Generate a brand-new Nostr key pair and store it. Returns { ok, account }. */
  generate() {
    const { sk, pk } = generateKeys();
    const nsec = skToNsec(sk);
    const npub = pkToNpub(pk);
    store.setAccount({
      nsec,
      npub,
      rawPubkey: toHex(pk),
      displayName: this.shortNpub(npub),
      source: 'nsec',
      createdAt: Date.now(),
    });
    bus.emit('account:changed');
    return { ok: true, account: { ...this.current(), nsec } };
  },

  /** Connect with NIP-07 extension, npub, or nsec. Returns { ok, account?, error }. */
  async connect(secretOrMethod) {
    const value = (secretOrMethod || '').trim();

    if (value === 'nip07') {
      return this.connectNip07();
    }

    if (value.startsWith(NPUB_PREFIX)) {
      // Read-only identity; we can't sign events with just an npub.
      let rawPubkey;
      try { rawPubkey = toHex(npubToPk(value)); }
      catch { return { ok: false, error: 'account.invalid' }; }
      store.setAccount({
        npub: value,
        rawPubkey,
        displayName: this.shortNpub(value),
        source: 'npub',
        createdAt: Date.now(),
      });
      bus.emit('account:changed');
      return { ok: true, account: this.current() };
    }

    if (value.startsWith(NSEC_PREFIX)) {
      let pkHex, pkNpub;
      try {
        const { pk } = keysFromNsec(value);
        pkHex = toHex(pk);
        pkNpub = pkToNpub(pk);
      } catch {
        return { ok: false, error: 'account.invalid' };
      }
      // UI-complete fallback: store private key locally.
      // A real release should replace this with NIP-07/native secure storage.
      store.setAccount({
        nsec: value,
        npub: pkNpub,
        rawPubkey: pkHex,
        displayName: this.shortNpub(pkNpub),
        source: 'nsec',
        createdAt: Date.now(),
      });
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
      const npub = pkToNpub(fromHex(pubkey));
      store.setAccount({
        rawPubkey: pubkey,
        npub,
        displayName: this.shortNpub(npub),
        source: 'nip07',
        createdAt: Date.now(),
      });
      bus.emit('account:changed');
      return { ok: true, account: this.current() };
    } catch {
      return { ok: false, error: 'account.nip07Failed' };
    }
  },

  /** Show the private key for backup (only available for nsec-backed accounts). */
  revealSecret() {
    const acc = store.getAccount();
    return acc?.nsec || null;
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

function fromHex(hex) {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) throw new Error('bad hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}
