import http from "node:http";
import { listTaskIds, loadTask, publicView } from "@agent-league/shared";
import { Verifier } from "./verifier.js";

/**
 * HTTP API
 *   GET  /health
 *   GET  /tasks                      public task statements (no hidden tests)
 *   GET  /tasks/:id
 *   POST /answers   {round_id, agent, task_id, answer, meta?}  -> {answer_hash}
 *   POST /score     {round_id, task_id, agents[], on_chain_hashes?} -> signed score report
 *   GET  /results/:round_id
 *   GET  /answers/:round_id/:agent   answer text, only after the round is scored
 */
export function createServer(verifier: Verifier): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "content-type",
        });
        return res.end();
      }
      if (req.method === "GET" && url.pathname === "/health") {
        return send(200, { ok: true, public_keys: verifier.publicKeys });
      }
      if (req.method === "GET" && parts[0] === "tasks") {
        if (parts[1]) return send(200, publicView(loadTask(parts[1])));
        return send(200, listTaskIds().map((id) => publicView(loadTask(id))));
      }
      if (req.method === "GET" && parts[0] === "results" && parts[1]) {
        const r = verifier.getReport(Number(parts[1]));
        return r ? send(200, r) : send(404, { error: "not scored" });
      }
      if (req.method === "GET" && parts[0] === "answers" && parts[1] && parts[2]) {
        const roundId = Number(parts[1]);
        if (!verifier.getReport(roundId)) return send(403, { error: "answers are public only after scoring" });
        const a = verifier.getAnswer(roundId, parts[2]);
        return a ? send(200, a) : send(404, { error: "no answer" });
      }
      if (req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        if (url.pathname === "/answers") {
          const a = verifier.submit(Number(body.round_id), String(body.agent), String(body.task_id), String(body.answer), body.meta);
          return send(200, { answer_hash: a.answerHash });
        }
        if (url.pathname === "/score") {
          const r = await verifier.score(Number(body.round_id), String(body.task_id), body.agents as string[], body.on_chain_hashes);
          return send(200, r);
        }
      }
      send(404, { error: "not found" });
    } catch (e) {
      send(400, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      data += c;
      if (data.length > 256 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const keys = (process.env.VERIFIER_SECRET_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) {
    console.error("Set VERIFIER_SECRET_KEYS (comma-separated ed25519: secret keys). Run `npm run verifier:keygen` to make some.");
    process.exit(1);
  }
  const port = Number(process.env.VERIFIER_PORT ?? 8787);
  const verifier = new Verifier(keys, process.env.VERIFIER_DATA_DIR ?? ".data/verifier");
  createServer(verifier).listen(port, () => {
    console.log(`verifier listening on http://localhost:${port}`);
    console.log(`public keys: ${verifier.publicKeys.join(", ")}`);
  });
}
