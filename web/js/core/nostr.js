/**
 * core/nostr.js
 * Self-contained Nostr key utilities — no external deps, works on file://.
 *
 * Provides:
 *   - generateKeys()  → fresh { sk, pk } 32-byte keys
 *   - privateKeyToPublicKey(sk) → pk  (secp256k1 pubkey)
 *   - pubkeyToPoint() helpers
 *   - skToNsec(sk) / nsecToSk(nsec)       — private key bech32
 *   - pkToNpub(pk) / npubToPk(npub)       — public key bech32
 *
 * Bech32 is implemented inline (BIP-173 / NIP-19). secp256k1 is a compact
 * pure-JS implementation (point math + scalar mult) tuned for deriving a
 * 32-byte public key from a 32-byte private key — that is the only curve
 * operation Nostr identity needs locally. A production sync layer would
 * also sign events; that can later be added behind the same module API.
 */

/* =====================================================================
 * Bech32 (BIP-173) with Nostr NIP-19 prefixes (nsec, npub).
 * ===================================================================== */

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_POLY_MOD_CONST = 0x3b6a57b2; // generator constant

function bech32Polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= [0x0, BECH32_POLY_MOD_CONST, 0x26d086d2, 0x1ea119bb, 0x3d4233dd, 0x2a1462b3][i + 1];
    }
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function bech32CreateChecksum(hrp, data, spec = 'bech32') {
  const values = [...bech32HrpExpand(hrp), ...data];
  const constant = spec === 'bech32m' ? 0x2bc830a3 : 1;
  const polymod = bech32Polymod([...values, 0, 0, 0, 0, 0, 0]) ^ constant;
  const ret = [];
  for (let i = 0; i < 6; i++) ret.push((polymod >> (5 * (5 - i))) & 31);
  return ret;
}

function bech32VerifyChecksum(hrp, data, spec) {
  const constant = spec === 'bech32m' ? 0x2bc830a3 : 1;
  return bech32Polymod([...bech32HrpExpand(hrp), ...data]) === constant;
}

function convertBits(data, fromBits, toBits, pad = true) {
  let acc = 0, bits = 0;
  const ret = [], maxv = (1 << toBits) - 1, maxAcc = (1 << (fromBits + toBits - 1)) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits) throw new Error('invalid bech32 data');
    acc = ((acc << fromBits) | value) & maxAcc;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits) ret.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || (acc << (toBits - bits)) & maxv) {
    throw new Error('invalid padding');
  }
  return ret;
}

// Nostr uses bech32 for nsec / npub (NOT bech32m, which is for taproot etc.).
const SPEC = 'bech32';

export function bech32Encode(hrp, bytes) {
  const data = convertBits([...bytes], 8, 5);
  const checksum = bech32CreateChecksum(hrp, data, SPEC);
  return hrp + '1' + (data.concat(checksum)).map(v => BECH32_CHARSET[v]).join('');
}

export function bech32Decode(str) {
  if (typeof str !== 'string') throw new Error('bech32: not a string');
  str = str.toLowerCase();
  if (str.length > 90) throw new Error('bech32: too long');
  const pos = str.lastIndexOf('1');
  if (pos < 1 || pos + 7 > str.length) throw new Error('bech32: invalid separator');
  const hrp = str.slice(0, pos);
  for (const c of hrp) {
    if (c < '!' || c > '~') throw new Error('bech32: invalid hrp');
  }
  const dataPart = str.slice(pos + 1);
  for (const c of dataPart) {
    if (BECH32_CHARSET.indexOf(c) === -1) throw new Error('bech32: invalid char');
  }
  const data = [...dataPart].map(c => BECH32_CHARSET.indexOf(c));
  if (!bech32VerifyChecksum(hrp, data, SPEC)) throw new Error('bech32: bad checksum');
  const payload = convertBits(data.slice(0, -6), 5, 8, false);
  return { hrp, bytes: Uint8Array.from(payload) };
}

/* =====================================================================
 * Bytes helpers
 * ===================================================================== */

function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function hexFromBytes(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function bytesFromHex(hex) {
  if (hex.length % 2) throw new Error('hex: odd length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

const b64 = {
  to(bytes) { return btoa(String.fromCharCode(...bytes)); },
  from(str) { return Uint8Array.from(atob(str), c => c.charCodeAt(0)); },
};

/* =====================================================================
 * secp256k1 — minimal pure-JS implementation.
 *
 * Only what we need to derive an Nostr public key:
 *   - Field arithmetic mod p (32-byte limbs via BigInt)
 *   - Point addition / doubling in affine form with a common Z
 *   - Scalar multiplication via fixed-window
 *   - Public key compression / X-only output
 *
 * Constants and formulas from SEC 2 / NIST.
 * ===================================================================== */

const P = 2n ** 256n - 2n ** 32n - 977n;          // field prime p
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n; // curve order n
const A = 0n;
const B = 7n;
const Gx = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const Gy = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

function mod(a, m = P) { a %= m; return a < 0n ? a + m : a; }
function powMod(a, e, m) { a = mod(a, m); let r = 1n; while (e > 0n) { if (e & 1n) r = (r * a) % m; a = (a * a) % m; e >>= 1n; } return r; }
function invMod(a, m = P) { return powMod(a, m - 2n, m); }

// Jacobian point: (X, Y, Z). The point at infinity has Z = 0.
class Pt {
  constructor(x, y, z = 1n) { this.x = x; this.y = y; this.z = z; }
}

const ZERO = new Pt(1n, 1n, 0n);

function ptDouble(p) {
  if (p.z === 0n) return p;
  if (p.y === 0n) return ZERO;
  // Standard Jacobian doubling (a = 0):
  //   A = X²
  //   B = Y²
  //   C = B²
  //   D = 2·((X+B)² − A − C)
  //   E = 3·A + a·Z²     (a = 0 → E = 3A)
  //   F = E²
  //   X3 = F − 2·D
  //   Y3 = E·(D − X3) − 8·C
  //   Z3 = (Y+Z)² − B − Z²      (= 2·Y·Z)
  const A = mod(p.x * p.x);
  const B = mod(p.y * p.y);
  const C = mod(B * B);
  const D = mod(2n * (mod((p.x + B) * (p.x + B)) - A - C));
  const E = mod(3n * A);
  const F = mod(E * E);
  const x3 = mod(F - 2n * D);
  const y3 = mod(E * (D - x3) - 8n * C);
  const z3 = mod((p.y + p.z) * (p.y + p.z) - B - mod(p.z * p.z));
  return new Pt(x3, y3, z3);
}

function ptAdd(p, q) {
  if (p.z === 0n) return q;
  if (q.z === 0n) return p;
  // Convert to common Z=1 reference frame to make this affine-feel.
  const pInv = normalize(p);
  const qInv = normalize(q);
  if (pInv.x === qInv.x) {
    if (mod(pInv.y + qInv.y) === 0n) return ZERO;
    return ptDouble(pInv);
  }
  const lambda = mod((qInv.y - pInv.y) * invMod(mod(qInv.x - pInv.x)));
  const x3 = mod(lambda * lambda - pInv.x - qInv.x);
  const y3 = mod(lambda * (pInv.x - x3) - pInv.y);
  return new Pt(x3, y3, 1n);
}

function normalize(p) {
  if (p.z === 0n || p.z === 1n) return p;
  const zInv = invMod(p.z);
  const zInv2 = mod(zInv * zInv);
  return new Pt(mod(p.x * zInv2), mod(p.y * zInv2 * zInv), 1n);
}

// Scalar mult via simple left-to-right double-and-add.
function scalarMul(k, point) {
  let R = ZERO;
  const bits = [];
  let kk = k;
  while (kk > 0n) { bits.unshift(kk & 1n); kk >>= 1n; }
  const Q = point;
  for (const bit of bits) {
    R = ptDouble(R);
    if (bit === 1n) R = ptAdd(R, Q);
  }
  return normalize(R);
}

const G = new Pt(Gx, Gy, 1n);

/** Validate that 0 < sk < n. */
function validSecret(sk) {
  return sk > 0n && sk < N;
}

/** Derive the 32-byte X-only public key for a private key BigInt. */
export function pubkeyFromSecret(sk) {
  if (!validSecret(sk)) throw new Error('invalid secret key');
  const point = scalarMul(sk, G);
  if (point.z === 0n) throw new Error('pubkey derivation failed');
  // Nostr uses the x coordinate (32 bytes) as the public key.
  return point.x;
}

/* =====================================================================
 * Public API
 * ===================================================================== */

/** Generate a brand-new { sk, pk } pair, both returned as raw bytes (32). */
export function generateKeys() {
  let sk;
  // Re-roll on the rare off-chance the random draw is outside (1, n-1).
  do { sk = bigFromBytesBE(randomBytes(32)); } while (!validSecret(sk));
  const pk = pubkeyFromSecret(sk);
  return { sk: bytesBEFromBig(sk), pk: bytesBEFromBig(pk) };
}

/** Encode a 32-byte private key as `nsec1…`. */
export function skToNsec(skBytes) {
  if (!(skBytes instanceof Uint8Array) || skBytes.length !== 32) throw new Error('nsec: need 32 bytes');
  return bech32Encode('nsec', skBytes);
}

/** Decode an `nsec1…` string to raw 32 bytes. */
export function nsecToSk(nsec) {
  const { hrp, bytes } = bech32Decode(nsec);
  if (hrp !== 'nsec' || bytes.length !== 32) throw new Error('invalid nsec');
  return bytes;
}

/** Encode a 32-byte pubkey as `npub1…`. */
export function pkToNpub(pkBytes) {
  if (!(pkBytes instanceof Uint8Array) || pkBytes.length !== 32) throw new Error('npub: need 32 bytes');
  return bech32Encode('npub', pkBytes);
}

/** Decode an `npub1…` string to raw 32 bytes. */
export function npubToPk(npub) {
  const { hrp, bytes } = bech32Decode(npub);
  if (hrp !== 'npub' || bytes.length !== 32) throw new Error('invalid npub');
  return bytes;
}

/** Derive pubkey (32 bytes) from a private key (raw bytes). */
export function privateKeyToPublicKey(skBytes) {
  const sk = bigFromBytesBE(skBytes);
  return bytesBEFromBig(pubkeyFromSecret(sk));
}

/** Convenience: full pair from an nsec string. */
export function keysFromNsec(nsec) {
  const sk = nsecToSk(nsec);
  return { sk, pk: privateKeyToPublicKey(sk) };
}

/** Convenience: human-friendly hex of any 32-byte key. */
export function toHex(bytes) { return hexFromBytes(bytes); }
export function fromHex(hex) { return bytesFromHex(hex); }

/* ---- BigInt ↔ big-endian bytes ---- */

function bigFromBytesBE(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}
function bytesBEFromBig(value, length = 32) {
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v) throw new Error('value too large');
  return out;
}

// Keep b64 import referenced so this stays exportable for future event signing.
export const base64 = b64;
