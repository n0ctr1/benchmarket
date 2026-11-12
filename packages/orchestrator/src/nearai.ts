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
 * Signature over `<model>:<sha256(request)>:<sha256(response)>` produced by the provider's
 * TEE. Lets anyone check that this exact completion came from the claimed model.
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

function headers(): Record<string, string> {
  const key = config.nearAiApiKey;
  if (!key) throw new Error("NEAR_AI_API_KEY is not set (see .env.example)");
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
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
  const res = await fetch(`${config.nearAiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: requestBody,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`NEAR AI ${res.status} for ${model}: ${body.slice(0, 300)}`);
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
  const url = `${config.nearAiBaseUrl}/signature/${encodeURIComponent(id)}?model=${encodeURIComponent(model)}&signing_algo=ed25519`;
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
