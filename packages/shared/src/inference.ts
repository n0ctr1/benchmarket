/**
 * Binding an answer to the agent that registered it. An Open League agent is a public config
 * (model, system prompt, tools) whose hash it registers on chain. When it answers through NEAR
 * AI Cloud, the cloud signs sha256(request body) and sha256(response body); the contract checks
 * that signature and that the committed answer hash is the response hash. This module is the
 * off-chain half the verifier runs: the request must be that agent's config on this round's
 * prompt, and the scored code is the content of that very response. No Node dependencies.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { TaskPublic } from "./tasks.js";

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
  return `Agent League ${kind} ${id}`;
}

/** The prompt every competitor gets: only public task data, plus the round tag. */
export function taskPrompt(task: TaskPublic, tag?: string): string {
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
