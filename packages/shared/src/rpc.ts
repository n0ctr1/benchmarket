/** Minimal NEAR JSON-RPC view client on fetch (works in Node and browsers). */
export async function viewCall<T>(rpcUrl: string, contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const argsBase64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(args))));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "benchmarket",
        method: "query",
        params: { request_type: "call_function", finality: "optimistic", account_id: contractId, method_name: method, args_base64: argsBase64 },
      }),
    });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    const j = await res.json();
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
    if (j.result?.error) throw new Error(`${method}: ${j.result.error}`);
    return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result))) as T;
  }
}
