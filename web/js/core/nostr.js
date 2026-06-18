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
function powMod(a, e, m = P) { a = mod(a, m); let r = 1n; while (e > 0n) { if (e & 1n) r = (r * a) % m; a = (a * a) % m; e >>= 1n; } return r; }
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

// Scalar mult via simple left-to-right double-and-add. Returns the X-only
// coordinate (what Nostr identity needs).
function scalarMul(k, point) {
  const r = scalarMulPoint(k, point);
  return r.x;
}

// Full-point scalar multiplication — returns a normalized affine Pt (x, y, 1).
// Needed for ECDH (we need the shared point's x) and Schnorr (R lift + verify).
function scalarMulPoint(k, point) {
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
  const point = scalarMulPoint(sk, G);
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

/* =====================================================================
 * BIP-340 Schnorr signatures (used by Nostr event signing) + ECDH.
 *
 * secp256k1 has prime p with p % 4 === 3, so a square root mod p is
 *   y = w^((p+1)/4)  where w = x³ + 7. We pick the even y (BIP-340).
 * ===================================================================== */

// secp256k1 curve constant b = 7 (B is already declared at the top of the
// secp256k1 section as `const B = 7n`; reused here for liftX).
const P_PLUS1_DIV4 = (P + 1n) / 4n;

/** Lift an X coordinate to an even-Y point on the curve. Returns a Pt or null. */
function liftX(x) {
  if (x >= P) return null;
  const c = mod(x * x * x + B);
  let y = powMod(c, P_PLUS1_DIV4);          // y = c^((p+1)/4)
  if (mod(y * y) !== c) return null;        // not on curve
  if (y % 2n !== 0n) y = P - y;             // enforce even Y
  return new Pt(x, y, 1n);
}

/**
 * Tagged hash per BIP-340: SHA256(SHA256(tag) || SHA256(tag) || msg).
 * The tag is hashed once and cached, then prepended twice — NOT the raw tag
 * bytes. This is the part most pure-JS implementations get wrong.
 */
const _tagHashCache = new Map();
async function taggedHash(tag, msgBytes) {
  let tagHash = _tagHashCache.get(tag);
  if (!tagHash) {
    tagHash = await sha256Bytes(new TextEncoder().encode(tag));
    _tagHashCache.set(tag, tagHash);
  }
  const data = new Uint8Array(tagHash.length * 2 + msgBytes.length);
  data.set(tagHash, 0);
  data.set(tagHash, tagHash.length);
  data.set(msgBytes, tagHash.length * 2);
  return bigFromBytesBE(await sha256Bytes(data));
}

/**
 * BIP-340 Schnorr sign. Returns a 64-byte signature (R || s).
 *   auxRand: 32 random bytes (the "t" masking). Caller supplies so signing
 *            is deterministic-ish but still resistant to side channels.
 */
export async function schnorrSign(messageHash32, skBytes, auxRand) {
  if (!(messageHash32 instanceof Uint8Array) || messageHash32.length !== 32) throw new Error('schnorr: msg hash must be 32 bytes');
  if (!(skBytes instanceof Uint8Array) || skBytes.length !== 32) throw new Error('schnorr: sk must be 32 bytes');
  if (!(auxRand instanceof Uint8Array) || auxRand.length !== 32) throw new Error('schnorr: aux must be 32 bytes');

  let d = bigFromBytesBE(skBytes);
  if (!validSecret(d)) throw new Error('schnorr: invalid secret key');
  // Get the actual full point d·G — we need its Y to decide whether to negate d.
  const dG = scalarMulPoint(d, G);
  if (dG.z === 0n) throw new Error('schnorr: d*G is infinity');
  // Pk is the X-only pubkey = dG.x. The even-Y representative is liftX(dG.x).
  const Pk = liftX(mod(dG.x));
  if (!Pk) throw new Error('schnorr: pubkey lift failed');
  // If the actual d·G has odd Y, negate d so the even-Y lift is the correct P.
  // After negation, d'·G = -d·G which has the same X but even Y.
  if (mod(dG.y) % 2n !== 0n) d = N - d;

  let t = (await taggedHash('BIP0340/aux', auxRand));
  const tBE = bytesBEFromBig(t);
  const dBE = bytesBEFromBig(d);
  const tXorD = new Uint8Array(32);
  for (let i = 0; i < 32; i++) tXorD[i] = tBE[i] ^ dBE[i];

  const k0 = (await concatAndHash('BIP0340/nonce', tXorD, bytesBEFromBig(Pk.x), messageHash32));
  if (mod(k0) === 0n) throw new Error('schnorr: k=0 failure');
  let k = mod(k0, N);
  const R = scalarMulPoint(k, G);
  if (R.y % 2n !== 0n) k = N - k;             // R must have even Y

  const e = (await concatAndHash('BIP0340/challenge', bytesBEFromBig(R.x), bytesBEFromBig(Pk.x), messageHash32));
  const s = mod(k + mod(e, N) * d, N);
  const sig = new Uint8Array(64);
  sig.set(bytesBEFromBig(R.x), 0);
  sig.set(bytesBEFromBig(s), 32);
  return sig;
}

async function concatAndHash(tag, ...parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const data = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { data.set(p, off); off += p.length; }
  return taggedHash(tag, data);
}

/** BIP-340 Schnorr verify. Returns true if `sig` is valid for `pk`/`msgHash`. */
export async function schnorrVerify(messageHash32, pkBytes, sigBytes) {
  if (!(pkBytes instanceof Uint8Array) || pkBytes.length !== 32) return false;
  if (!(sigBytes instanceof Uint8Array) || sigBytes.length !== 64) return false;
  const px = bigFromBytesBE(pkBytes);
  const Pk = liftX(px);
  if (!Pk) return false;
  const r = bigFromBytesBE(sigBytes.subarray(0, 32));
  const s = bigFromBytesBE(sigBytes.subarray(32));
  if (r >= P || s >= N) return false;
  const e = (await concatAndHash('BIP0340/challenge', bytesBEFromBig(r), pkBytes, messageHash32));
  const eMod = mod(e, N);
  // s·G + e·Pk should equal R (even-Y). We compute s·G − e·P and check X == r.
  const sG = scalarMulPoint(s, G);
  const eP = scalarMulPoint(eMod, Pk);
  // Negate eP (affine, Z=1): (x, −y mod p).
  const negE = new Pt(eP.x, mod(P - eP.y), 1n);
  const R = ptAdd(sG, negE);   // sG - eP
  if (R.z === 0n) return false;
  return mod(R.x) === r;
}

/* =====================================================================
 * ECDH (X-only) — shared secret for NIP-44.
 * Returns the X coordinate of sk·peerPk. NIP-44 then HKDFs this.
 * ===================================================================== */

export function ecdh(skBytes, peerPkBytes) {
  if (!(skBytes instanceof Uint8Array) || skBytes.length !== 32) throw new Error('ecdh: sk must be 32 bytes');
  if (!(peerPkBytes instanceof Uint8Array) || peerPkBytes.length !== 32) throw new Error('ecdh: pk must be 32 bytes');
  const sk = bigFromBytesBE(skBytes);
  if (!validSecret(sk)) throw new Error('ecdh: invalid secret key');
  const x = bigFromBytesBE(peerPkBytes);
  const Pk = liftX(x);
  if (!Pk) throw new Error('ecdh: peer pubkey not on curve');
  const shared = scalarMulPoint(sk, Pk);
  return bytesBEFromBig(shared.x);   // 32-byte X-only shared secret
}

/* =====================================================================
 * NIP-01 event serialization + signing.
 * ===================================================================== */

const NIP01_INT_FIELDS = ['created_at', 'kind'];

function serializeEvent(ev) {
  // Canonical JSON per NIP-01: [0, pubkey, created_at, kind, tags, content]
  return JSON.stringify([
    0,
    ev.pubkey,
    ev.created_at,
    ev.kind,
    ev.tags || [],
    ev.content || '',
  ]);
}

/**
 * Compute the event id (the SHA-256 of its canonical serialization) and sign
 * it locally with the supplied secret key (BIP-340 Schnorr). Returns a full,
 * publish-ready event { id, pubkey, created_at, kind, tags, content, sig }.
 */
export async function finishEvent(unsignedEvent, skBytes) {
  const sk = bigFromBytesBE(skBytes);
  if (!validSecret(sk)) throw new Error('finishEvent: invalid secret key');
  const pkBigInt = pubkeyFromSecret(sk);
  const pkBytes = bytesBEFromBig(pkBigInt);
  const ev = {
    pubkey: toHex(pkBytes),
    created_at: unsignedEvent.created_at ?? Math.floor(Date.now() / 1000),
    kind: unsignedEvent.kind,
    tags: unsignedEvent.tags || [],
    content: unsignedEvent.content || '',
  };
  const idHex = await sha256Hex(new TextEncoder().encode(serializeEvent(ev)));
  ev.id = idHex;
  const aux = randomBytes(32);
  ev.sig = hexFromBytes(await schnorrSign(hexToBytes(idHex), skBytes, aux));
  return ev;
}

/* ---- hashing helpers (WebCrypto with a pure-JS fallback) ---- */

let _subtle = null;
try { _subtle = (globalThis.crypto && globalThis.crypto.subtle) || null; } catch {}

async function sha256Bytes(data) {
  if (_subtle) {
    const digest = await _subtle.digest('SHA-256', data);
    return new Uint8Array(digest);
  }
  return sha256BytesPure(data);
}

async function sha256Hex(data) {
  return hexFromBytes(await sha256Bytes(data));
}

function hexToBytes(hex) {
  if (hex.length % 2) throw new Error('hex: odd length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/* ---- minimal pure-JS SHA-256 (offline / file:// fallback) ---- */
export function __sha256Pure(data) { return sha256BytesPure(data); }
function sha256BytesPure(data) {
  // Standard FIPS 180-4 implementation. Only used if crypto.subtle is absent.
  const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ]);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);

  const l = data.length;
  const bitLen = l * 8;
  const withPad = (((l + 9) + 63) >> 6) << 6;     // total 64-byte blocks
  const buf = new Uint8Array(withPad);
  buf.set(data);
  buf[l] = 0x80;
  // 64-bit big-endian length in the last 8 bytes
  const dv = new DataView(buf.buffer);
  dv.setUint32(withPad - 4, bitLen >>> 0, false);
  dv.setUint32(withPad - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);

  const w = new Uint32Array(64);
  for (let i = 0; i < withPad; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i], false);
  return out;
}

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
