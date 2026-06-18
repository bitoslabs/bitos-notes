/**
 * core/nip44.js
 * NIP-44 v2 symmetric encryption for Nostr direct messages / private payloads.
 *
 * Spec: https://github.com/nostr-protocol/nips/blob/master/44.md
 *
 * Pipeline:
 *   1. ECDH (X-only) shared secret  ← core/nostr.js `ecdh(sk, peerPk)`
 *   2. HKDF-Extract(salt="nip44-v2", IKM=shared)  → 32-byte conversation key
 *   3. per-message: HKDF-Expand(conv, info="nip44-v2", L=88)
 *        - bytes [0..31]   = ChaCha20 key
 *        - bytes [32..63]  = HMAC-SHA256 key (message keys)
 *        - bytes [64..87]  = ChaCha20 nonce (24 bytes — we use first 12)
 *   4. plaintext → padded (per spec min-length table) → ChaCha20 stream encrypt
 *   5. MAC = HMAC-SHA256(macKey, version(1) || padded-len(2) || nonce(24) || ciphertext)
 *   6. payload = base64( version(1) || len(2) || nonce(24) || ciphertext || MAC(32) ) = 99 + ct
 *
 * WebCrypto provides SHA-256 / HMAC / HKDF-Extract. ChaCha20 is implemented
 * inline (RFC 8439) since WebCrypto has no ChaCha20. If crypto.subtle is
 * unavailable (file:// / insecure context) we fall back to a pure-JS SHA-256
 * (from core/nostr.js) and a pure-JS HMAC, so encryption still works offline.
 */

import { ecdh } from './nostr.js';

const VERSION = 2;
const SALT = 'nip44-v2';
const INFO = new TextEncoder().encode('nip44-v2');

let _subtle = null;
try { _subtle = (globalThis.crypto && globalThis.crypto.subtle) || null; } catch {}

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ---------- base64 helpers ---------- */
function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------- SHA-256 / HMAC-SHA256 (subtle with pure-JS fallback) ---------- */

async function sha256(data) {
  if (_subtle) return new Uint8Array(await _subtle.digest('SHA-256', data));
  // Fallback uses the pure-JS impl exported from nostr.js (sha256BytesPure).
  const { __sha256Pure } = await import('./nostr.js');
  return __sha256Pure(data);
}

async function hmacKey(keyBytes) {
  if (_subtle) {
    return _subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  }
  return keyBytes;   // raw bytes — used by hmacSignFallback
}

async function hmac(key, data) {
  if (_subtle) {
    // key may be raw bytes or a CryptoKey — always ensure it's a CryptoKey.
    const k = key instanceof Uint8Array ? await hmacKey(key) : key;
    const sig = await _subtle.sign('HMAC', k, data);
    return new Uint8Array(sig);
  }
  // Pure-JS HMAC: H((key ⊕ opad) || H((key ⊕ ipad) || data))
  const block = 64;
  let k = key;
  if (k.length > block) k = await sha256(k);
  if (k.length < block) { const padded = new Uint8Array(block); padded.set(k); k = padded; }
  const ipad = new Uint8Array(block), opad = new Uint8Array(block);
  for (let i = 0; i < block; i++) { ipad[i] = k[i] ^ 0x36; opad[i] = k[i] ^ 0x5c; }
  const inner = new Uint8Array(block + data.length);
  inner.set(ipad, 0); inner.set(data, block);
  const innerHash = await sha256(inner);
  const outer = new Uint8Array(block + innerHash.length);
  outer.set(opad, 0); outer.set(innerHash, block);
  return sha256(outer);
}

/* ---------- HKDF (RFC 5869) ---------- */

async function hkdfExtract(salt, ikm) {
  const saltKey = await hmacKey(salt);
  return hmac(saltKey, ikm);
}

async function hkdfExpand(prk, info, length) {
  // NIST SP 800-56C / RFC 5869. SHA-256 → block size 32.
  const blocks = [];
  let prev = new Uint8Array(0);
  let t = new Uint8Array(0);
  const n = Math.ceil(length / 32);
  for (let i = 1; i <= n; i++) {
    const data = new Uint8Array(prev.length + info.length + 1);
    data.set(prev, 0);
    data.set(info, prev.length);
    data[prev.length + info.length] = i;
    const prkKey = await hmacKey(prk);
    t = await hmac(prkKey, data);
    blocks.push(t);
    prev = t;
  }
  const out = new Uint8Array(length);
  let off = 0;
  for (const b of blocks) {
    const take = Math.min(b.length, length - off);
    out.set(b.subarray(0, take), off);
    off += take;
  }
  return out;
}

/* ---------- ChaCha20 (RFC 8439, IETF 96-bit nonce, single block counter) ----------
 * We only need raw stream encryption (no Poly1305 — MAC is separate HMAC above).
 * The nonce is the per-message HKDF-derived 24-byte value; IETF ChaCha20 uses
 * the first 12 bytes of it as the nonce (NIP-44 reference uses bytes [76..87]).
 */

function rotl32(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }
function quarter(s, a, b, c, d) {
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl32(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl32(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl32(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl32(s[b] ^ s[c], 7);
}

function chacha20Block(key32, nonce12, counter) {
  // IETF ChaCha20 state (RFC 8439 §2.3):
  //   [0..3]   = "expand 32-byte k" constants
  //   [4..11]  = 256-bit key
  //   [12]     = block counter
  //   [13..15] = 96-bit nonce
  const kdv = new DataView(key32.buffer, key32.byteOffset, 32);
  const ndv = new DataView(nonce12.buffer, nonce12.byteOffset, 12);
  const st = new Uint32Array(16);
  st[0] = 0x61707865; st[1] = 0x3320646e; st[2] = 0x79622d32; st[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) st[4 + i] = kdv.getUint32(i * 4, true);
  st[12] = counter >>> 0;
  st[13] = ndv.getUint32(0, true);
  st[14] = ndv.getUint32(4, true);
  st[15] = ndv.getUint32(8, true);

  const out = new Uint32Array(st);
  for (let i = 0; i < 10; i++) {
    quarter(out, 0, 4, 8, 12);  quarter(out, 1, 5, 9, 13);
    quarter(out, 2, 6, 10, 14); quarter(out, 3, 7, 11, 15);
    quarter(out, 0, 5, 10, 15); quarter(out, 1, 6, 11, 12);
    quarter(out, 2, 7, 8, 13);  quarter(out, 3, 4, 9, 14);
  }
  const bytes = new Uint8Array(64);
  const odv = new DataView(bytes.buffer);
  for (let i = 0; i < 16; i++) odv.setUint32(i * 4, (out[i] + st[i]) >>> 0, true);
  return bytes;
}

function chacha20Stream(key, nonce, data) {
  const out = new Uint8Array(data.length);
  let counter = 0;
  let offset = 0;
  while (offset < data.length) {
    const block = chacha20Block(key, nonce, counter);
    const take = Math.min(64, data.length - offset);
    for (let i = 0; i < take; i++) out[offset + i] = data[offset + i] ^ block[i];
    offset += take;
    counter++;
  }
  return out;
}

/* ---------- Padding (NIP-44 v2) ---------- */
function padLength(unpadded) {
  // NIP-44 v2 chunk table. Protects against length-leak while keeping small
  // messages compact.
  const CHUNKS = [32, 64, 128, 256, 512, 1024, 2048, 4096];
  if (unpadded <= CHUNKS[0]) return CHUNKS[0];
  let next = CHUNKS[0];
  for (const c of CHUNKS) if (unpadded > c) next = c * 2;
  // round up to the next multiple of 32 in the chosen chunk range
  if (unpadded <= CHUNKS[CHUNKS.length - 1]) {
    for (const c of CHUNKS) {
      if (unpadded <= c) return c;
    }
  }
  // larger than 4096: round up to next multiple of 1024
  return Math.ceil(unpadded / 1024) * 1024;
}

function u16be(n) { return [(n >> 8) & 0xff, n & 0xff]; }
function readU16BE(buf, off) { return ((buf[off] << 8) | buf[off + 1]) >>> 0; }

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ---------- Public API ---------- */

/**
 * Derive the 32-byte conversation key from a private key and peer pubkey.
 * Both inputs are raw 32-byte values (nsec-decoded sk, npub-decoded pk).
 */
export async function getConversationKey(skBytes, peerPkBytes) {
  const shared = ecdh(skBytes, peerPkBytes);  // 32 bytes (X-only)
  return hkdfExtract(enc.encode(SALT), shared);
}

/**
 * Encrypt plaintext (UTF-8). Returns a base64 payload string.
 * sk = our secret key, peerPk = recipient's pubkey (for self-DM, peer = own pk).
 */
export async function encrypt(plaintext, skBytes, peerPkBytes) {
  const conv = await getConversationKey(skBytes, peerPkBytes);
  const keys = await hkdfExpand(conv, INFO, 88);
  const chachaKey = keys.subarray(0, 32);
  const macKey = keys.subarray(32, 64);
  const nonce = keys.subarray(64, 76);          // 12-byte IETF nonce

  const pt = enc.encode(plaintext);
  const paddedLen = padLength(pt.length);
  const padded = new Uint8Array(paddedLen);
  padded.set(pt);

  const ciphertext = chacha20Stream(chachaKey, nonce, padded);

  // MAC over: version(1) || paddedLen(2) || nonce(24-zero-padded) || ciphertext
  const noncePadded = new Uint8Array(24);
  noncePadded.set(nonce, 0);
  const macInput = new Uint8Array(1 + 2 + 24 + ciphertext.length);
  macInput[0] = VERSION;
  macInput[1] = u16be(paddedLen)[0]; macInput[2] = u16be(paddedLen)[1];
  macInput.set(noncePadded, 3);
  macInput.set(ciphertext, 27);
  const mac = await hmac(macKey, macInput);

  // payload: version(1) || paddedLen(2) || nonce(24) || ciphertext || mac(32)
  const payload = new Uint8Array(1 + 2 + 24 + ciphertext.length + 32);
  let off = 0;
  payload[off++] = VERSION;
  payload[off++] = u16be(paddedLen)[0]; payload[off++] = u16be(paddedLen)[1];
  payload.set(noncePadded, off); off += 24;
  payload.set(ciphertext, off); off += ciphertext.length;
  payload.set(mac, off);
  return b64encode(payload);
}

/**
 * Decrypt a base64 NIP-44 v2 payload. Returns the plaintext string.
 * Throws on version mismatch, length errors, or MAC failure.
 */
export async function decrypt(payloadB64, skBytes, peerPkBytes) {
  const buf = b64decode(payloadB64);
  if (buf.length < 91) throw new Error('nip44: payload too short');
  if (buf[0] !== VERSION) throw new Error('nip44: unsupported version ' + buf[0]);

  const paddedLen = readU16BE(buf, 1);
  const nonce = buf.subarray(3, 15);              // 12 bytes for ChaCha20
  const nonceField = buf.subarray(3, 27);         // full 24-byte nonce field (for MAC)
  const ctEnd = buf.length - 32;
  const ciphertext = buf.subarray(27, ctEnd);     // after version(1)+len(2)+nonce(24)
  const mac = buf.subarray(ctEnd);

  const conv = await getConversationKey(skBytes, peerPkBytes);
  const keys = await hkdfExpand(conv, INFO, 88);
  const chachaKey = keys.subarray(0, 32);
  const macKey = keys.subarray(32, 64);

  // Verify MAC (constant-time). MAC covers version(1) + paddedLen(2) + nonce(24) + ct.
  const macInput = new Uint8Array(1 + 2 + 24 + ciphertext.length);
  macInput[0] = VERSION;
  macInput[1] = u16be(paddedLen)[0]; macInput[2] = u16be(paddedLen)[1];
  macInput.set(nonceField, 3);
  macInput.set(ciphertext, 27);
  const expected = await hmac(macKey, macInput);
  if (!constantTimeEqual(mac, expected)) throw new Error('nip44: MAC verification failed');

  const padded = chacha20Stream(chachaKey, nonce, ciphertext);
  if (padded.length !== paddedLen) throw new Error('nip44: length mismatch');
  // The NIP-44 reference stores unpadded length implicitly: strip trailing
  // zero bytes the encoder appended (our plaintext was never null-terminated).
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end--;
  return dec.decode(padded.subarray(0, end));
}
