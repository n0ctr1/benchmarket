/**
 * NEAR AI Cloud end-to-end encryption (version 2): a field is encrypted to the model enclave's
 * ed25519 key (converted to X25519) with a fresh ephemeral key, HKDF-SHA256 (info
 * "ed25519_encryption") and XChaCha20-Poly1305. Wire format, hex: ephemeral public key (32) |
 * nonce (24) | ciphertext with tag. Responses come back the same way, encrypted to the client's key.
 *
 * Whoever knows a field's ephemeral secret (or the client's secret, for the response) can open it,
 * so a client can let one party, such as the verifier, read exactly one exchange by revealing the
 * one-time keys it used for it. No Node dependencies: the dashboard can use it.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const INFO = utf8ToBytes("ed25519_encryption");

/** X25519 public key of an ed25519 public key (hex). */
export function modelX25519(ed25519PubHex: string): Uint8Array {
  return ed25519.utils.toMontgomery(hexToBytes(ed25519PubHex));
}

function key(shared: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, undefined, INFO, 32);
}

/** Encrypts `plaintext` to an X25519 key. Returns the field (hex) and its ephemeral secret (hex). */
export function sealField(recipientX25519: Uint8Array, plaintext: string, ephemeralSecret = randomBytes(32), nonce = randomBytes(24)): { field: string; secret: string } {
  const eph = x25519.getPublicKey(ephemeralSecret);
  const k = key(x25519.getSharedSecret(ephemeralSecret, recipientX25519));
  const ct = xchacha20poly1305(k, nonce).encrypt(utf8ToBytes(plaintext));
  const out = new Uint8Array(32 + 24 + ct.length);
  out.set(eph, 0);
  out.set(nonce, 32);
  out.set(ct, 56);
  return { field: bytesToHex(out), secret: bytesToHex(ephemeralSecret) };
}

/** Opens a field with the recipient's X25519 secret. */
export function openField(recipientSecret: Uint8Array, fieldHex: string): string {
  const raw = hexToBytes(fieldHex);
  const k = key(x25519.getSharedSecret(recipientSecret, raw.slice(0, 32)));
  return new TextDecoder().decode(xchacha20poly1305(k, raw.slice(32, 56)).decrypt(raw.slice(56)));
}

/** Opens a field one encrypted to someone else, given the ephemeral secret used for it. */
export function openWithEphemeral(ephemeralSecretHex: string, recipientX25519: Uint8Array, fieldHex: string): string {
  const raw = hexToBytes(fieldHex);
  const secret = hexToBytes(ephemeralSecretHex);
  if (bytesToHex(x25519.getPublicKey(secret)) !== bytesToHex(raw.slice(0, 32))) throw new Error("ephemeral secret does not match the field");
  const k = key(x25519.getSharedSecret(secret, recipientX25519));
  return new TextDecoder().decode(xchacha20poly1305(k, raw.slice(32, 56)).decrypt(raw.slice(56)));
}

/** A one-time client key for one exchange: ed25519 public key for the header, X25519 secret to open replies. */
export function clientKey(seed: Uint8Array = randomBytes(32)): { seed: string; pubHex: string; x25519Secret: Uint8Array } {
  return { seed: bytesToHex(seed), pubHex: bytesToHex(ed25519.getPublicKey(seed)), x25519Secret: ed25519.utils.toMontgomerySecret(seed) };
}
