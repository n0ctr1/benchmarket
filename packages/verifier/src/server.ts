import http from "node:http";
import { listTaskIds, loadTask, publicView, roundTag, sha256Tagged, taskPrompt, verifyMessage, verifyNep413, viewCall } from "@benchmarket/shared";
import { answerCode, Verifier, type Kind } from "./verifier.js";

/**
 * `task_ref` is a task id, optionally with a variant: `parse-duration@smoke` runs the same
 * tests under its own (uncurated, unrated) difficulty record.
 */
export const taskIdOf = (taskRef: string) => taskRef.split("@")[0];

/** What the server reads from the league contract. */
export interface ChainReader {
  get(kind: Kind, id: number): Promise<{ task_ref: string; status: string; entries: Array<{ agent: string; answer_hash: string | null }> } | null>;
  /** The full job, for client tasks and confidential work. */
  jobMeta?(id: number): Promise<unknown>;
  /** Whether `publicKey` is an access key of `account`. */
  hasKey?(account: string, publicKey: string): Promise<boolean>;
  /** The config hash an agent registered on its passport. */
  configHash?(agent: string): Promise<string | null>;
  /** The league contract's account (what a poster's signature names). */
  contract?: string;
}

/** Reads rounds and jobs over JSON-RPC. A job looks like a round with one entrant. */
export function rpcChain(rpcUrl: string, contractId: string): ChainReader {
  return {
    contract: contractId,
    async configHash(agent) {
      const i = await viewCall<{ config_hash?: string } | null>(rpcUrl, contractId, "get_identity", { agent });
      return i?.config_hash ?? null;
    },
    async jobMeta(id) {
      return viewCall(rpcUrl, contractId, "get_job", { job_id: id });
    },
    async hasKey(account, publicKey) {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "benchmarket", method: "query", params: { request_type: "view_access_key", finality: "final", account_id: account, public_key: publicKey } }),
      });
      const j = (await res.json()) as { result?: { permission?: unknown }; error?: unknown };
      // Only a full-access key speaks for the account: function-call keys are app keys.
      return !!j.result && !j.error && j.result.permission === "FullAccess";
    },
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
 *   POST /jobs/:id/client-task              {task, tests}: a client's own task, bound to the
 *                                           job's committed tests hash; only the hired agent
 *                                           can then read it, by signing benchmarket:job-task:<id>
 *   POST /jobs/:id/sealed                   {function, tests, response, request, sealed, config}:
 *                                           a confidential job the client ran in the enclave
 *
 * Both POSTs about a client's task are the job poster's only: headers x-account, x-key, x-sig
 * and x-nonce carry a NEP-413 wallet signature over
 * `benchmarket:<client-task|sealed>:<contract>:<job id>:<sha256 of the body>`, by a full-access
 * key of the poster's account, with a nonce used once. A task is bound once and never replaced.
 */
export function createServer(verifier: Verifier, chain?: ChainReader): http.Server {
  // Jobs whose task is being bound right now (set before the body is read), and nonces seen.
  const binding = new Set<number>();
  const nonces = new Set<string>();
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
          "access-control-allow-headers": "content-type, x-agent, x-agent-key, x-agent-sig, x-account, x-key, x-sig, x-nonce",
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
        if (kind === "job" && req.method === "POST" && parts[2] === "client-task") {
          const job = (await chain.jobMeta?.(id)) as { tests_hash: string; status: string; poster: string } | null;
          if (!job) return send(404, { error: "no such job" });
          if (job.status !== "Taken") return send(409, { error: "a task is handed over while the hire is working on the job" });
          if (binding.has(id) || verifier.clientTask(id) || verifier.published(id, "job")) return send(409, { error: "this job's task is already bound" });
          binding.add(id);
          try {
            const raw = await readBody(req);
            if (!(await signedByPoster(req, chain, nonces, "client-task", id, job.poster, raw))) return send(403, { error: "only the job's poster, signing this request with its wallet, can hand over its task" });
            const body = JSON.parse(raw);
            verifier.provideClientTask(id, body.task, String(body.tests), job.tests_hash);
          } finally {
            binding.delete(id);
          }
          return send(200, { ok: true, tests_hash: job.tests_hash });
        }
        if (kind === "job" && req.method === "POST" && parts[2] === "sealed") {
          // The client ran the hire's public config sealed to the model enclave and committed the
          // answer on chain; here it reveals its tests and the one-time keys of that exchange only.
          const job = (await chain.jobMeta?.(id)) as {
            tests_hash: string;
            poster: string;
            agent: string | null;
            answer_hash: string | null;
            answer_attested: boolean;
            request_hash: string | null;
            model: string | null;
          } | null;
          if (!job || !job.agent || !job.answer_hash) return send(400, { error: "commit the answer on chain first" });
          if (binding.has(id) || verifier.clientTask(id) || verifier.published(id, "job")) return send(409, { error: "this job's task is already bound" });
          binding.add(id);
          let body: Record<string, any>;
          let configHash: string | null;
          try {
            const raw = await readBody(req);
            if (!(await signedByPoster(req, chain, nonces, "sealed", id, job.poster, raw))) return send(403, { error: "only the job's poster, signing this request with its wallet, can reveal its confidential run" });
            body = JSON.parse(raw);
            // The revealed response must be the one committed on chain.
            if (sha256Tagged(String(body.response)) !== job.answer_hash) return send(400, { error: "the response does not hash to the answer committed on chain" });
            // The config the hire registered on its passport, read from chain, never from the request.
            configHash = (await chain.configHash?.(job.agent)) ?? null;
            if (!configHash) return send(400, { error: "the hired agent has no registered config on chain" });
            // Check the exchange before anything is bound or signed: a run that is not the hire's
            // registered config on this job gets no signature at all, never a signed 0 against it.
            const candidate = { agent: job.agent, taskId: "client", answer: String(body.response), answerHash: sha256Tagged(String(body.response)), receivedAt: Date.now(), request: String(body.request), config: body.config, sealed: body.sealed };
            const pre = answerCode({ agent: job.agent, answer_hash: job.answer_hash, attested: job.answer_attested, request_hash: job.request_hash, model: job.model, config_hash: configHash }, candidate, roundTag("job", id));
            if (pre.check) return send(400, { error: `not scored, nothing signed: ${pre.check}` });
          } finally {
            binding.delete(id);
          }
          const fn = String(body.function);
          verifier.provideClientTask(id, { title: String(body.title ?? "client task"), statement: String(body.statement ?? "(confidential)"), function: fn, examples: [] }, String(body.tests), job.tests_hash);
          verifier.submit(id, job.agent, "client", String(body.response), { mode: "llm", confidential: true }, { kind: "job", request: String(body.request), config: body.config, sealed: body.sealed });
          const report = await verifier.scoreJob(id, "client", {
            agent: job.agent,
            answer_hash: job.answer_hash,
            attested: job.answer_attested,
            request_hash: job.request_hash,
            model: job.model,
            config_hash: configHash,
          });
          return send(200, { totalTests: report.totalTests, score: report.details[0]?.score ?? 0, check: report.details[0]?.check ?? null, message: report.message, signatures: report.signatures });
        }
        if (req.method === "GET" && parts[2] === "task") {
          const client = kind === "job" ? verifier.clientTask(id) : undefined;
          if (client) {
            // Only the hired agent reads a client's task: it signs benchmarket:job-task:<id> with a key of its account.
            const agent = String(req.headers["x-agent"] ?? "");
            const pk = String(req.headers["x-agent-key"] ?? "");
            const sig = String(req.headers["x-agent-sig"] ?? "");
            const hired = onChain.entries[0]?.agent;
            if (!agent || agent !== hired) return send(403, { error: "only the hired agent can read this task" });
            if (!(await chain.hasKey?.(agent, pk)) || !verifyMessage(pk, `benchmarket:job-task:${id}`, sig)) return send(403, { error: "bad agent signature" });
            const tag = roundTag(kind, id);
            const task = { id: `job-${id}`, skill: "code.js", title: client.title, statement: client.statement, function: client.function, examples: client.examples };
            return send(200, { task, tag, prompt: taskPrompt(task, tag), status: onChain.status });
          }
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
      // Report what was wrong with the request, never a stack or a local path.
      const msg = e instanceof Error ? e.message : String(e);
      send(400, { error: msg.replace(/\/[^\s:'"]+/g, "<path>").slice(0, 300) });
    }
  });
}

/**
 * Whether the request carries the poster's NEP-413 wallet signature over this action on this job
 * and this exact body, with a nonce not seen before, by a full-access key of the poster.
 */
async function signedByPoster(req: http.IncomingMessage, chain: ChainReader, nonces: Set<string>, action: string, id: number, poster: string, body: string): Promise<boolean> {
  const h = (n: string) => String(req.headers[n] ?? "");
  const account = h("x-account");
  const pk = h("x-key");
  const sig = h("x-sig");
  const nonce = h("x-nonce");
  if (!account || account !== poster || !pk || !sig || !nonce || !chain.contract || nonces.has(nonce)) return false;
  const message = `benchmarket:${action}:${chain.contract}:${id}:${sha256Tagged(body)}`;
  if (!verifyNep413(pk, message, nonce, chain.contract, sig)) return false;
  if (!(await chain.hasKey?.(account, pk))) return false;
  nonces.add(nonce);
  return true;
}

const MAX_BODY = 2 * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    const onData = (c: string) => {
      data += c;
      if (data.length > MAX_BODY) {
        // Stop reading at the cap: drop the listener and the connection.
        req.off("data", onData);
        req.destroy();
        reject(new Error("body too large"));
      }
    };
    req.on("data", onData);
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
  // Behind a reverse proxy set VERIFIER_HOST=127.0.0.1 so only the proxy reaches it.
  const host = process.env.VERIFIER_HOST ?? "0.0.0.0";
  createServer(verifier, chain).listen(port, host, () => {
    console.log(`verifier listening on http://${host}:${port}`);
    console.log(`public keys: ${verifier.publicKeys.join(", ")}`);
  });
}
