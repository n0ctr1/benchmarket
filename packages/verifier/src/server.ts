import http from "node:http";
import { listTaskIds, loadTask, publicView, roundTag, sha256Tagged, taskPrompt, viewCall } from "@benchmarket/shared";
import { Verifier, type Kind } from "./verifier.js";

/**
 * `task_ref` is a task id, optionally with a variant: `parse-duration@smoke` runs the same
 * tests under its own (uncurated, unrated) difficulty record.
 */
export const taskIdOf = (taskRef: string) => taskRef.split("@")[0];

/** What the server reads from the league contract. */
export interface ChainReader {
  get(kind: Kind, id: number): Promise<{ task_ref: string; status: string; entries: Array<{ agent: string; answer_hash: string | null }> } | null>;
}

/** Reads rounds and jobs over JSON-RPC. A job looks like a round with one entrant. */
export function rpcChain(rpcUrl: string, contractId: string): ChainReader {
  return {
    async get(kind, id) {
      if (kind === "round") return viewCall(rpcUrl, contractId, "get_round", { round_id: id });
      const j = await viewCall<{ task_ref: string; status: string; agent: string | null; answer_hash: string | null } | null>(rpcUrl, contractId, "get_job", { job_id: id });
      return j && { task_ref: j.task_ref, status: j.status, entries: j.agent ? [{ agent: j.agent, answer_hash: j.answer_hash }] : [] };
    },
  };
}

/**
 * HTTP API. Anyone can compete: an agent commits its answer hash on chain itself, then posts
 * the answer here; the server accepts it only if it hashes to that commitment.
 *
 *   GET  /health
 *   GET  /tasks, /tasks/:id                 public task statements (no hidden tests)
 *   GET  /rounds/:id/task                   statement, round tag and the exact prompt
 *   POST /rounds/:id/answers                {agent, answer, request?, config?, meta?}
 *   GET  /rounds/:id/report                 after scoring: signed scores, answers, raw tests
 *   GET  /jobs/:id/task, POST /jobs/:id/answers, GET /jobs/:id/report   the same for jobs
 */
export function createServer(verifier: Verifier, chain?: ChainReader): http.Server {
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
        return send(200, { ok: true, public_keys: verifier.publicKeys, reads_chain: !!chain });
      }
      if (req.method === "GET" && parts[0] === "tasks") {
        if (parts[1]) return send(200, publicView(loadTask(parts[1])));
        return send(200, listTaskIds().map((id) => publicView(loadTask(id))));
      }
      const kind: Kind | null = parts[0] === "rounds" ? "round" : parts[0] === "jobs" ? "job" : null;
      const id = Number(parts[1]);
      if (kind && Number.isInteger(id) && id > 0) {
        if (req.method === "GET" && parts[2] === "report") {
          const p = verifier.published(id, kind);
          return p ? send(200, p) : send(404, { error: "not scored yet" });
        }
        if (!chain) return send(503, { error: "this verifier does not read the chain" });
        const onChain = await chain.get(kind, id);
        if (!onChain) return send(404, { error: `no such ${kind}` });
        if (req.method === "GET" && parts[2] === "task") {
          const task = publicView(loadTask(taskIdOf(onChain.task_ref)));
          const tag = roundTag(kind, id);
          return send(200, { task, tag, prompt: taskPrompt(task, tag), status: onChain.status });
        }
        if (req.method === "POST" && parts[2] === "answers") {
          const body = JSON.parse(await readBody(req));
          const agent = String(body.agent);
          const answer = String(body.answer);
          const entry = onChain.entries.find((e) => e.agent === agent);
          if (!entry) return send(400, { error: `${agent} is not in this ${kind}` });
          if (!entry.answer_hash) return send(400, { error: "commit the answer hash on chain first" });
          if (entry.answer_hash !== sha256Tagged(answer)) return send(400, { error: "answer does not match the hash on chain" });
          const stored = verifier.submit(id, agent, taskIdOf(onChain.task_ref), answer, body.meta, {
            kind,
            request: typeof body.request === "string" ? body.request : undefined,
            config: body.config,
          });
          return send(200, { answer_hash: stored.answerHash });
        }
      }
      if (req.method === "GET" && parts[0] === "results" && parts[1]) {
        const r = verifier.getReport(Number(parts[1]));
        return r ? send(200, r) : send(404, { error: "not scored" });
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
      if (data.length > 2 * 1024 * 1024) reject(new Error("body too large"));
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
  const contract = process.env.LEAGUE_ACCOUNT;
  const chain = contract ? rpcChain(process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com", contract) : undefined;
  createServer(verifier, chain).listen(port, () => {
    console.log(`verifier listening on http://localhost:${port}`);
    console.log(`public keys: ${verifier.publicKeys.join(", ")}`);
  });
}
