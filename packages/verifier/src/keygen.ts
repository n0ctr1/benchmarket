import { generateKeyPair } from "@benchmarket/shared";

// Prints N fresh verifier key pairs. Secret keys go into .env, public keys into the contract init.
const n = Number(process.argv[2] ?? 3);
const pairs = Array.from({ length: n }, generateKeyPair);
console.log(`VERIFIER_SECRET_KEYS=${pairs.map((p) => p.secretKey).join(",")}`);
console.log(`VERIFIER_PUBLIC_KEYS=${pairs.map((p) => p.publicKey).join(",")}`);
