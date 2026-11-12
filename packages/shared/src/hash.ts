import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/** Hex SHA-256 of a UTF-8 string, prefixed with `sha256:`. Used for answer and test hashes. */
export function sha256Tagged(text: string): string {
  return `sha256:${bytesToHex(sha256(utf8ToBytes(text)))}`;
}

export function sha256Bytes(text: string): Uint8Array {
  return sha256(utf8ToBytes(text));
}
