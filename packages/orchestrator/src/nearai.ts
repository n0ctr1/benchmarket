import { randomBytes } from "node:crypto";
import https from "node:https";
import { clientKey, modelX25519, openField, sealField } from "@benchmarket/shared";
import { config } from "./config.js";

/** OpenAI-compatible client for NEAR AI Cloud. */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  id: string;
  model: string;
  content: string;
  /** Exact bodies sent and received: NEAR AI signs their SHA-256. */
  requestBody: string;
  responseBody: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  latencyMs: number;
}

/**
 * NEAR AI's signature over `[<model>:]<sha256(request)>:<sha256(response)>`: from the model's own
 * enclave when NEAR AI hosts it in a TEE (the text names the model), from the gateway otherwise.
 */
export interface CompletionSignature {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: string;
  signature_kind?: string;
}

export class ChatError extends Error {
  constructor(message: string, readonly outOfTokens = false) {
    super(message);
  }
}

/** Which of the configured keys is in use; moves on when one is out of credit. */
let keyIndex = 0;

function headers(index = keyIndex): Record<string, string> {
  const key = config.nearAiApiKeys[index];
  if (!key) throw new Error("NEAR_AI_API_KEY is not set (see .env.example)");
  // x-no-aliasing: a canonical model id, so models NEAR AI hosts in a TEE sign from their own
  // enclave; identity encoding, because the signature covers the uncompressed body.
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "x-no-aliasing": "true", "Accept-Encoding": "identity" };
}

export async function chat(
  model: string,
  messages: ChatMessage[],
  opts: { maxTokens?: number; timeoutMs?: number; json?: boolean } = {},
): Promise<ChatResult> {
  const started = Date.now();
  const requestBody = JSON.stringify({
    model,
    messages,
    max_tokens: opts.maxTokens ?? 32000,
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
  });
  // node:https, not fetch: fetch drops a response whose headers take more than 300 s.
  const res = await completions({}, requestBody, opts.timeoutMs ?? 600_000);
  const body = res.text;
  if (res.status !== 200) throw new Error(`NEAR AI ${res.status} for ${model}: ${body.slice(0, 300)}`);
  const j = JSON.parse(body);
  const choice = j.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new ChatError(`empty completion from ${model} (finish_reason ${choice?.finish_reason ?? "?"})`, choice?.finish_reason === "length");
  }
  return { id: j.id, model: j.model ?? model, content, usage: j.usage, latencyMs: Date.now() - started, requestBody, responseBody: body };
}

/**
 * Fetches the signature for a completion. It can take a moment to appear, so this retries a
 * few times; returns null if the cloud has none.
 */
export async function completionSignature(id: string, model: string, attempts = 4): Promise<CompletionSignature | null> {
  // ECDSA: the model's enclave key for models NEAR AI hosts in a TEE (signature_kind
  // provider_tee, the text names the model), the gateway's key otherwise.
  const url = `${config.nearAiBaseUrl}/signature/${encodeURIComponent(id)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(20_000) });
      if (res.ok) {
        const j = (await res.json()) as CompletionSignature;
        if (j && typeof j.signature === "string") return j;
      }
    } catch {
      // try again
    }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return null;
}

/** The contract's attestation argument for a signature. */
export function attestationArg(s: CompletionSignature) {
  return { text: s.text, signature: s.signature, signer: s.signing_address };
}

/** Signing keys from NEAR AI's attestation reports: the gateway's and each listed model's enclave. */
export async function attestedSigners(models: string[]): Promise<{ gateway: string[]; models: Array<{ model: string; key: string }> }> {
  const out = { gateway: [] as string[], models: [] as Array<{ model: string; key: string }> };
  const get = async (q: string) => {
    const r = await fetch(`${config.nearAiBaseUrl}/attestation/report?${q}`, { headers: headers(), signal: AbortSignal.timeout(30_000) }).catch(() => null);
    return r?.ok ? ((await r.json()) as { gateway_attestation?: { signing_address?: string }; model_attestations?: Array<{ model_name?: string; signing_address?: string }> }) : null;
  };
  for (const algo of ["ed25519", "ecdsa"]) {
    const g = (await get(`signing_algo=${algo}`))?.gateway_attestation?.signing_address;
    if (g) out.gateway.push(g.toLowerCase());
  }
  for (const m of models) {
    const rep = await get(`model=${encodeURIComponent(m)}&signing_algo=ecdsa`);
    for (const a of rep?.model_attestations ?? []) {
      if (a.signing_address && a.model_name === m) out.models.push({ model: m, key: a.signing_address.toLowerCase() });
    }
  }
  return out;
}
export interface SealedChat {
  /** Exact encrypted bodies: NEAR AI signs their hashes. */
  requestBody: string;
  responseBody: string;
  /** The assistant's reply, decrypted. */
  content: string;
  signature: CompletionSignature | null;
  /** The one-time keys that open exactly this exchange (for the verifier). */
  sealed: { modelPub: string; fieldSecrets: string[]; clientSeed: string };
  latencyMs: number;
}

/**
 * A completion sealed to the model's enclave: every message is encrypted to the enclave key from a
 * fresh attestation report (nonce checked), the reply comes back encrypted to a one-time client
 * key. The report's TDX quote and GPU evidence are not verified here, so the gateway that serves
 * the report is trusted not to substitute its own key (RULES.md section 12).
 */
export async function sealedChat(model: string, messages: ChatMessage[], maxTokens = 32000, timeoutMs = 600_000): Promise<SealedChat> {
  const nonce = randomBytes(32).toString("hex");
  const rep = await fetch(`${config.nearAiBaseUrl}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ed25519&nonce=${nonce}&include_tls_fingerprint=false`, {
    headers: headers(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!rep.ok) throw new Error(`${model} has no enclave attestation (${rep.status}): it cannot take confidential work`);
  const report = (await rep.json()) as { model_attestations?: Array<{ model_name?: string; signing_public_key?: string }> };
  const att = report.model_attestations?.find((a) => a.model_name === model && a.signing_public_key);
  if (!att || !JSON.stringify(report.model_attestations).includes(nonce)) throw new Error(`no fresh enclave attestation for ${model}`);
  const modelPub = att.signing_public_key!;
  const recipient = modelX25519(modelPub);
  const fields = messages.map((m) => sealField(recipient, m.content));
  const me = clientKey();
  const requestBody = JSON.stringify({ model, messages: messages.map((m, i) => ({ role: m.role, content: fields[i].field })), max_tokens: maxTokens });
  const started = Date.now();
  const res = await completions({ "X-Signing-Algo": "ed25519", "X-Client-Pub-Key": me.pubHex, "X-Model-Pub-Key": modelPub, "X-Encryption-Version": "2" }, requestBody, timeoutMs);
  const responseBody = res.text;
  if (res.status !== 200) throw new Error(`NEAR AI ${res.status} for ${model}: ${responseBody.slice(0, 300)}`);
  const j = JSON.parse(responseBody);
  const sealedContent = j.choices?.[0]?.message?.content;
  if (typeof sealedContent !== "string" || !sealedContent) throw new ChatError(`empty completion from ${model}`, j.choices?.[0]?.finish_reason === "length");
  return {
    requestBody,
    responseBody,
    content: openField(me.x25519Secret, sealedContent),
    signature: await completionSignature(j.id, model),
    sealed: { modelPub, fieldSecrets: fields.map((f) => f.secret), clientSeed: me.seed },
    latencyMs: Date.now() - started,
  };
}

/**
 * POSTs a completion; a key that is out of credit (402) hands over to the next one in .env.
 * Each request tracks the key it used, so requests in flight together all move on, not only the
 * first one to see the 402.
 */
async function completions(extra: Record<string, string>, body: string, timeoutMs: number) {
  let i = keyIndex;
  let res = await postLong(`${config.nearAiBaseUrl}/chat/completions`, { ...headers(i), ...extra }, body, timeoutMs);
  while (res.status === 402 && i + 1 < config.nearAiApiKeys.length) {
    i++;
    if (i > keyIndex) {
      keyIndex = i;
      console.log(`  (NEAR AI key ${i} is out of credit; switching to key ${i + 1})`);
    }
    res = await postLong(`${config.nearAiBaseUrl}/chat/completions`, { ...headers(i), ...extra }, body, timeoutMs);
  }
  return res;
}

/**
 * POST over node:https. Node's fetch gives up waiting for response headers after 300 s whatever
 * the abort signal says; reasoning models answering a whole task without streaming take longer.
 */
function postLong(url: string, hdrs: Record<string, string>, body: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "POST", headers: { ...hdrs, "Content-Length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`timed out after ${timeoutMs / 1000}s`), { name: "TimeoutError" })));
    req.on("error", reject);
    req.end(body);
  });
}
