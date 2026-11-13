import { clientKey, modelX25519, openField, sealField } from "@benchmarket/shared/e2ee";

/**
 * A confidential job run from the client's own browser: the hired agent's public config (model
 * and system prompt) runs on the client's task inside the model's enclave on NEAR AI, with the
 * prompt and the answer end-to-end encrypted (NEAR AI E2EE v2). NEAR AI sees ciphertext only;
 * the enclave signs the exchange. The client's NEAR AI key stays in this tab's memory.
 */
const BASE = "https://cloud-api.near.ai/v1";

export interface SealedRun {
  requestBody: string;
  responseBody: string;
  content: string;
  signature: { text: string; signature: string; signing_address: string; signing_algo: string; signature_kind?: string } | null;
  sealed: { modelPub: string; fieldSecrets: string[]; clientSeed: string };
}

export async function sealedRun(apiKey: string, model: string, system: string, prompt: string): Promise<SealedRun> {
  const auth = { Authorization: `Bearer ${apiKey}` };
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  const rep = await fetch(`${BASE}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ed25519&nonce=${nonce}&include_tls_fingerprint=false`, { headers: auth });
  if (!rep.ok) throw new Error(`${model} has no enclave attestation (${rep.status}); it cannot take confidential work`);
  const report = (await rep.json()) as { model_attestations?: Array<{ model_name?: string; signing_public_key?: string }> };
  const att = report.model_attestations?.find((a) => a.model_name === model && a.signing_public_key);
  if (!att || !JSON.stringify(report.model_attestations).includes(nonce)) throw new Error(`no fresh enclave attestation for ${model}`);
  const modelPub = att.signing_public_key!;
  const recipient = modelX25519(modelPub);
  const messages = [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];
  const fields = messages.map((m) => sealField(recipient, m.content));
  const me = clientKey();
  const requestBody = JSON.stringify({ model, messages: messages.map((m, i) => ({ role: m.role, content: fields[i].field })), max_tokens: 32000 });
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json", "X-Signing-Algo": "ed25519", "X-Client-Pub-Key": me.pubHex, "X-Model-Pub-Key": modelPub, "X-Encryption-Version": "2" },
    body: requestBody,
  });
  const responseBody = await res.text();
  if (!res.ok) throw new Error(`NEAR AI ${res.status}: ${responseBody.slice(0, 200)}`);
  const j = JSON.parse(responseBody);
  const sealedContent = j.choices?.[0]?.message?.content;
  if (typeof sealedContent !== "string" || !sealedContent) throw new Error(`empty completion from ${model}`);
  // The enclave's ECDSA signature over sha256(request):sha256(response).
  let signature: SealedRun["signature"] = null;
  for (let i = 0; i < 4 && !signature; i++) {
    const s = await fetch(`${BASE}/signature/${encodeURIComponent(j.id)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, { headers: auth }).catch(() => null);
    if (s?.ok) {
      const sj = await s.json();
      if (typeof sj?.signature === "string") signature = sj;
    }
    if (!signature) await new Promise((r) => setTimeout(r, 1500));
  }
  return {
    requestBody,
    responseBody,
    content: openField(me.x25519Secret, sealedContent),
    signature,
    sealed: { modelPub, fieldSecrets: fields.map((f) => f.secret), clientSeed: me.seed },
  };
}
