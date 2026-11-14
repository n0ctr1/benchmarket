import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { sha256Bytes } from "./hash.js";

/** An ed25519 key pair in NEAR string format. */
export interface NearKeyPair {
  /** `ed25519:<base58 of 64 bytes: seed + public key>` (the format near-cli stores). */
  secretKey: string;
  /** `ed25519:<base58 of 32 bytes>` */
  publicKey: string;
}

const PREFIX = "ed25519:";

function seedFromSecret(secretKey: string): Uint8Array {
  if (!secretKey.startsWith(PREFIX)) throw new Error("expected an ed25519: secret key");
  const raw = base58.decode(secretKey.slice(PREFIX.length));
  if (raw.length !== 64 && raw.length !== 32) throw new Error(`bad secret key length ${raw.length}`);
  return raw.slice(0, 32);
}

export function generateKeyPair(): NearKeyPair {
  const seed = ed25519.utils.randomSecretKey();
  return keyPairFromSeed(seed);
}

export function keyPairFromSeed(seed: Uint8Array): NearKeyPair {
  const pub = ed25519.getPublicKey(seed);
  const full = new Uint8Array(64);
  full.set(seed, 0);
  full.set(pub, 32);
  return { secretKey: PREFIX + base58.encode(full), publicKey: PREFIX + base58.encode(pub) };
}

export function publicKeyOf(secretKey: string): string {
  return PREFIX + base58.encode(ed25519.getPublicKey(seedFromSecret(secretKey)));
}

/** Signs SHA-256(message) and returns the 64-byte signature as base64 (the contract's Base64VecU8). */
export function signMessage(secretKey: string, message: string): string {
  const sig = ed25519.sign(sha256Bytes(message), seedFromSecret(secretKey));
  return base64.encode(sig);
}

export function verifyMessage(publicKey: string, message: string, signatureB64: string): boolean {
  if (!publicKey.startsWith(PREFIX)) return false;
  const pub = base58.decode(publicKey.slice(PREFIX.length));
  return ed25519.verify(base64.decode(signatureB64), sha256Bytes(message), pub);
}

/**
 * NEP-413 (the wallets' `signMessage`): the wallet signs sha256(u32 LE 2^31 + 413 ||
 * borsh{message: string, nonce: [u8; 32], recipient: string, callbackUrl: Option<string>}).
 * This is how a person proves, from a browser wallet, that a request comes from their account.
 */
export function nep413Digest(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  if (nonce.length !== 32) throw new Error("the NEP-413 nonce is 32 bytes");
  const str = (s: string) => {
    const b = new TextEncoder().encode(s);
    const out = new Uint8Array(4 + b.length);
    new DataView(out.buffer).setUint32(0, b.length, true);
    out.set(b, 4);
    return out;
  };
  const tag = new Uint8Array(4);
  new DataView(tag.buffer).setUint32(0, 2 ** 31 + 413, true);
  const parts = [tag, str(message), nonce, str(recipient), new Uint8Array([0])];
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return nobleSha256(all);
}

export function signNep413(secretKey: string, message: string, nonce: Uint8Array, recipient: string): string {
  return base64.encode(ed25519.sign(nep413Digest(message, nonce, recipient), seedFromSecret(secretKey)));
}

export function verifyNep413(publicKey: string, message: string, nonceB64: string, recipient: string, signatureB64: string): boolean {
  try {
    if (!publicKey.startsWith(PREFIX)) return false;
    const pub = base58.decode(publicKey.slice(PREFIX.length));
    return ed25519.verify(base64.decode(signatureB64), nep413Digest(message, base64.decode(nonceB64), recipient), pub);
  } catch {
    return false;
  }
}
