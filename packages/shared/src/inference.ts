/**
 * Binding an answer to the agent that registered it. An Open League agent is a public config
 * (model, system prompt, tools) whose hash it registers on chain. When it answers through NEAR
 * AI Cloud, the cloud signs sha256(request body) and sha256(response body); the contract checks
 * that signature and that the committed answer hash is the response hash. This module is the
 * off-chain half the verifier runs: the request must be that agent's config on this round's
 * prompt, and the scored code is the content of that very response. No Node dependencies.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
/** The public part of a task (same shape as `TaskPublic` in tasks.ts, kept here so browsers need no Node types). */
interface TaskPublic {
  function: string;
  statement: string;
  examples: Array<{ args: unknown[]; expected: unknown }>;
}

export interface PublicConfig {
  name: string;
  model: string;
  systemPrompt: string;
  tools: string[];
}

const hex = (s: string) => bytesToHex(sha256(utf8ToBytes(s)));

/** Hash of the public config, recorded on chain at registration. Key order is part of the format. */
export function configHash(c: PublicConfig): string {
  return "sha256:" + hex(JSON.stringify({ name: c.name, model: c.model, systemPrompt: c.systemPrompt, tools: c.tools }));
}

/** Names the round (or job) in the prompt, so a completion cannot be replayed in another one. */
export function roundTag(kind: "round" | "job", id: number): string {
  return `Benchmarket ${kind} ${id}`;
}

/** The prompt every competitor gets: only public task data, plus the round tag. */
export function taskPrompt(task: TaskPublic, tag?: string): string {
  if (task.function.startsWith("sql:")) {
    // A SQL task: each example is a database (the SQL that builds it) and the rows to return.
    const shown = task.examples.map((e, i) => `Example ${i + 1} database:\n${String(e.args[0])}\nExpected rows: ${JSON.stringify(e.expected)}`).join("\n\n");
    const head = tag ? `${tag}.\n\n` : "";
    return `${head}${task.statement}\n\n${shown}\n\nWrite one SQLite SELECT statement (a WITH clause is fine, no semicolons inside). Answer with a single fenced sql code block.`;
  }
  const examples = task.examples
    .map((e) => `${task.function}(${e.args.map((a) => JSON.stringify(a)).join(", ")}) === ${JSON.stringify(e.expected)}`)
    .join("\n");
  const head = tag ? `${tag}.\n\n` : "";
  return `${head}${task.statement}\n\nExamples:\n${examples}\n\nWrite the function \`${task.function}\`.`;
}

export interface Completion {
  /** Exact request body sent to NEAR AI Cloud. */
  request: string;
  /** Exact response body it returned. */
  response: string;
}

export interface CompletionCheck {
  ok: boolean;
  reason?: string;
  /** The assistant message, when the response parses. */
  content?: string;
}

/** Content of the first choice of an OpenAI-style chat response body. */
export function completionContent(response: string): string | null {
  try {
    const c = JSON.parse(response)?.choices?.[0]?.message?.content;
    return typeof c === "string" ? c : null;
  } catch {
    return null;
  }
}

/**
 * Checks a completion against what is on chain: the request hash the cloud signed, the agent's
 * registered config hash, the model, the system prompt and the round tag.
 */
export function checkCompletion(
  c: Completion,
  expect: { requestHash?: string | null; model?: string | null; configHash: string; config?: PublicConfig; tag: string },
): CompletionCheck {
  if (expect.requestHash && hex(c.request) !== expect.requestHash) return { ok: false, reason: "request does not match the signed request hash" };
  if (!expect.config) return { ok: false, reason: "agent did not publish its config" };
  if (configHash(expect.config) !== expect.configHash) return { ok: false, reason: "published config does not match the registered config hash" };
  let req: { model?: unknown; messages?: Array<{ role?: unknown; content?: unknown }> };
  try {
    req = JSON.parse(c.request);
  } catch {
    return { ok: false, reason: "request is not JSON" };
  }
  if (req.model !== expect.config.model) return { ok: false, reason: `request used model ${String(req.model)}, config says ${expect.config.model}` };
  if (expect.model && expect.model !== expect.config.model) return { ok: false, reason: `signed model ${expect.model} differs from the config` };
  const msgs = Array.isArray(req.messages) ? req.messages : [];
  if (msgs[0]?.role !== "system" || msgs[0]?.content !== expect.config.systemPrompt) return { ok: false, reason: "system prompt differs from the registered config" };
  if (!msgs.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes(expect.tag))) {
    return { ok: false, reason: `prompt does not name ${expect.tag}` };
  }
  const content = completionContent(c.response);
  if (content === null) return { ok: false, reason: "response has no assistant content" };
  return { ok: true, content };
}

/** NEAR AI Cloud's signature over a completion, as `/v1/signature/{id}` returns it. */
export interface NearAiSignature {
  text: string;
  signature: string;
  signing_address: string;
}

/**
 * Checks a NEAR AI signature the way the contract does: ed25519 over the text (key as 64 hex), or
 * ECDSA secp256k1 over the EIP-191 message (signer as a 0x address).
 */
export function verifyNearAiSignature(s: NearAiSignature): boolean {
  try {
    const signer = s.signing_address.toLowerCase();
    if (signer.startsWith("0x")) {
      const sig = hexToBytes(s.signature.replace(/^0x/, ""));
      if (sig.length !== 65) return false;
      const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
      const msg = utf8ToBytes(`\x19Ethereum Signed Message:\n${s.text.length}${s.text}`);
      const pub = secp256k1.Signature.fromBytes(sig.slice(0, 64), "compact").addRecoveryBit(v).recoverPublicKey(keccak_256(msg)).toBytes(false);
      return "0x" + bytesToHex(keccak_256(pub.slice(1)).slice(12)) === signer;
    }
    return ed25519.verify(hexToBytes(s.signature), utf8ToBytes(s.text), hexToBytes(signer));
  } catch {
    return false;
  }
}
