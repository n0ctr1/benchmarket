import { useState } from "react";
import { sha256Tagged } from "@benchmarket/shared/hash";
import { roundTag, taskPrompt } from "@benchmarket/shared/inference";
import { near, short, type Brief, type Identity, type Job, type Rating, type Task } from "../chain";
import { CATEGORIES, SCOUT_MIN_STAKE } from "../categories";
import { Identicon } from "../Figure";
import type { RosterAgent } from "../offchain";
import { sealedRun, type SealedRun } from "../sealed";
import { Briefs, Jobs } from "../Tables";
import { useTx, useWallet } from "../wallet";

declare const __VERIFIER__: string;

const yocto = (t: string) => {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t.trim());
  return m ? BigInt(m[1] || "0") * 10n ** 24n + BigInt((m[2] ?? "").slice(0, 24).padEnd(24, "0") || "0") : 0n;
};

/** The connected account's briefs and jobs, with what it can do next; open briefs it can scout. */
export function MyLeague({ briefs, jobs, identities, ratings, tasks, roster, onRound }: { briefs: Brief[]; jobs: Job[]; identities: Identity[]; ratings: Rating[]; tasks: Task[]; roster: RosterAgent[]; onRound: (id: number) => void }) {
  const w = useWallet();
  if (!w.account)
    return (
      <div className="gate">
        <h3>Connect a wallet</h3>
        <p className="muted">Your briefs and jobs appear here once a NEAR wallet is connected: offers to accept, tasks to hand over, payouts to finalize, open briefs to scout.</p>
        <button className="btn btn-accent" onClick={w.connect} disabled={!w.ready}>
          Connect wallet
        </button>
      </div>
    );
  const mine = briefs.filter((b) => b.client === w.account);
  const myJobs = jobs.filter((j) => j.poster === w.account || j.agent === w.account);
  const open = briefs.filter((b) => b.status === "Scouting" && b.client !== w.account);
  return (
    <div className="my">
      <section>
        <h2 className="sub">Your briefs</h2>
        {mine.length === 0 && <p className="muted">No briefs from {w.account} yet. Post one under “Post a task”.</p>}
        {mine.map((b) => (
          <div key={b.id} className="my-brief">
            <Briefs briefs={[b]} identities={identities} jobs={jobs} onRound={onRound} />
            <BriefActions brief={b} job={jobs.find((j) => j.id === b.job_id)} roster={roster} />
          </div>
        ))}
      </section>
      <section>
        <h2 className="sub">Your jobs</h2>
        {myJobs.length === 0 ? <p className="muted">No jobs posted by or taken by this account.</p> : <Jobs jobs={myJobs} identities={identities} />}
        {myJobs
          .filter((j) => j.status === "Proposed")
          .map((j) => (
            <Finalize key={j.id} job={j} />
          ))}
      </section>
      <section>
        <h2 className="sub">Open briefs to scout</h2>
        <p className="muted">Anyone can scout: put an agent forward for a brief and stake on it. If the agent is hired and delivers, you share the scout reward; if it fails, you lose the stake.</p>
        {open.length === 0 && <p className="muted">No brief is taking nominations right now.</p>}
        {open.map((b) => (
          <Nominate key={b.id} brief={b} identities={identities} ratings={ratings} tasks={tasks} />
        ))}
      </section>
    </div>
  );
}

function TxLine({ tx }: { tx: ReturnType<typeof useTx> }) {
  if (!tx.error && !tx.done && !tx.busy) return null;
  return (
    <p className="tx-status" data-kind={tx.error ? "error" : tx.done ? "done" : ""}>
      {tx.busy ? "Waiting for the wallet…" : tx.error ?? `${tx.done}. The page updates within a few seconds.`}
    </p>
  );
}

/** What the client can do with its brief now: accept or decline an offer, then hand the task over. */
function BriefActions({ brief, job, roster }: { brief: Brief; job?: Job; roster: RosterAgent[] }) {
  const tx = useTx();
  if (brief.status === "Offered")
    return (
      <div className="act">
        <span className="act-k">Offer: {short(brief.offered ?? "")} won the tryout</span>
        <Handover brief={brief} />
        <span className="act-row">
          <button className="btn btn-ghost" disabled={tx.busy} onClick={() => tx.run("Offer declined", "decline_offer", { brief_id: brief.id })}>
            Decline and get a refund
          </button>
        </span>
        <TxLine tx={tx} />
      </div>
    );
  if (brief.status === "Hired" && job) return <Deliver brief={brief} job={job} hire={roster.find((r) => r.id === short(job.agent ?? ""))} />;
  return null;
}

/** The client's real task: a statement for the hire and hidden tests that decide payment. */
function Handover({ brief }: { brief: Brief }) {
  const tx = useTx();
  const [title, setTitle] = useState("");
  const [fn, setFn] = useState("solve");
  const [tests, setTests] = useState('[\n  { "args": [1, 2], "expected": 3 }\n]');
  let testsOk = false;
  try {
    const t = JSON.parse(tests);
    testsOk = Array.isArray(t) && t.length > 0 && t.every((x) => Array.isArray(x.args) && "expected" in x);
  } catch {
    testsOk = false;
  }
  const slug = (title || "task").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "task";
  const ref = `client-${slug}@brief-${brief.id}`;
  const hash = sha256Tagged(tests);
  // The statement and tests are kept in this tab until the hire is confirmed, then delivered.
  const save = () => {
    try {
      sessionStorage.setItem(`bm.handover.${brief.id}`, JSON.stringify({ title, fn, tests }));
    } catch {
      /* storage blocked: the form keeps them */
    }
  };
  return (
    <div className="handover">
      <p className="muted">
        Commit to your hidden tests now: only their hash goes on chain. The statement and the tests are delivered next, to the verifier and the hire only{brief.confidential ? "; a confidential brief runs in the model's enclave instead" : ""}.
      </p>
      <div className="field-row">
        <label className="field">
          <span className="field-k">Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Shop CSV parser" />
        </label>
        <label className="field">
          <span className="field-k">Function name</span>
          <input value={fn} onChange={(e) => setFn(e.target.value.trim())} />
        </label>
      </div>
      <label className="field">
        <span className="field-k">Hidden tests (JSON)</span>
        <textarea rows={5} value={tests} onChange={(e) => setTests(e.target.value)} spellCheck={false} />
        <span className="field-note">An array of {"{ args, expected }"}. Hash {hash.slice(0, 26)}… · task ref {ref}</span>
      </label>
      <span className="act-row">
        <button
          className="btn btn-accent"
          disabled={!testsOk || !/^[A-Za-z_$][\w$]*$/.test(fn) || tx.busy}
          onClick={() => {
            save();
            void tx.run("Offer accepted", "accept_offer", { brief_id: brief.id, task_ref: ref, tests_hash: hash }, 0n, 150);
          }}
        >
          {tx.account ? "Accept the offer" : "Connect wallet"}
        </button>
      </span>
      <TxLine tx={tx} />
    </div>
  );
}

/** After the hire: send the task to the verifier, or run it sealed in the enclave and settle. */
function Deliver({ brief, job, hire }: { brief: Brief; job: Job; hire?: RosterAgent }) {
  const tx = useTx();
  const w = useWallet();
  const saved = (() => {
    try {
      return JSON.parse(sessionStorage.getItem(`bm.handover.${brief.id}`) ?? "null") as { title: string; fn: string; tests: string } | null;
    } catch {
      return null;
    }
  })();
  const [title, setTitle] = useState(saved?.title ?? "");
  const [fn, setFn] = useState(saved?.fn ?? "solve");
  const [tests, setTests] = useState(saved?.tests ?? "");
  const [statement, setStatement] = useState("");
  const [examples, setExamples] = useState("[]");
  const [key, setKey] = useState("");
  const [run, setRun] = useState<SealedRun | null>(null);
  const [verdict, setVerdict] = useState<{ totalTests: number; score: number; signatures: string[]; check: string | null } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const hashOk = tests && sha256Tagged(tests) === job.tests_hash;
  const task = () => ({ id: `job-${job.id}`, skill: "code.js", title: title || "Client task", statement, function: fn, examples: JSON.parse(examples || "[]") });

  if (job.status !== "Taken" && job.status !== "Answered") return null;
  const tag = roundTag("job", job.id);
  return (
    <div className="act">
      <span className="act-k">Hand the task to {short(job.agent ?? "")}</span>
      <label className="field">
        <span className="field-k">Statement for the hire</span>
        <textarea rows={6} value={statement} onChange={(e) => setStatement(e.target.value)} placeholder={`Write a JavaScript function \`${fn}(...)\` that ...`} />
      </label>
      <div className="field-row">
        <label className="field">
          <span className="field-k">Function name</span>
          <input value={fn} onChange={(e) => setFn(e.target.value.trim())} />
        </label>
        <label className="field">
          <span className="field-k">Examples shown to the hire (JSON)</span>
          <input value={examples} onChange={(e) => setExamples(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span className="field-k">The hidden tests you committed</span>
        <textarea rows={4} value={tests} onChange={(e) => setTests(e.target.value)} spellCheck={false} />
        <span className="field-note">{hashOk ? "Matches the hash on chain." : "Must be byte for byte the tests you committed when accepting."}</span>
      </label>
      {!brief.confidential ? (
        <span className="act-row">
          <button
            className="btn btn-accent"
            disabled={!hashOk || !statement.trim()}
            onClick={async () => {
              setMsg(null);
              const payload = JSON.stringify({ task: { title: title || "Client task", statement, function: fn, examples: JSON.parse(examples || "[]") }, tests });
              const auth = await w.authHeaders("client-task", job.id, payload).catch((e) => ({ error: String(e instanceof Error ? e.message : e) }));
              if ("error" in auth) return setMsg(`Wallet: ${auth.error}`);
              const r = await fetch(`${__VERIFIER__}/jobs/${job.id}/client-task`, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: payload }).catch((e) => ({ ok: false, json: async () => ({ error: String(e) }) }) as Response);
              const j = await r.json().catch(() => ({}));
              setMsg(r.ok ? "Delivered. Only the hire can read it, by signing with its own key; the verifier scores its answer on your tests." : `Verifier: ${j.error ?? "unreachable"}`);
            }}
          >
            Send the task to the verifier
          </button>
        </span>
      ) : (
        <>
          <p className="muted">
            Confidential: run {hire ? `${hire.name}'s public config (${hire.model})` : "the hire's config"} on your task inside the model's enclave, from this browser. Your NEAR AI key stays in this tab; the task is sealed to the enclave key from NEAR AI's attestation report (its TDX quote is not verified here yet), and the enclave signs the exchange.
          </p>
          <label className="field">
            <span className="field-k">Your NEAR AI API key</span>
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
          </label>
          <span className="act-row">
            <button
              className="btn btn-accent"
              disabled={!hire || !key || !statement.trim() || !hashOk || !!run}
              onClick={async () => {
                setMsg("Running in the enclave…");
                try {
                  const r = await sealedRun(key, hire!.model, hire!.systemPrompt, taskPrompt(task(), tag));
                  setRun(r);
                  setMsg(r.signature ? `Answered and signed by the ${hire!.model} enclave.` : "Answered, but the enclave signature did not arrive; try again.");
                } catch (e) {
                  setMsg(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              1. Run sealed
            </button>
            <button
              className="btn btn-line"
              disabled={!run?.signature || job.status !== "Taken" || tx.busy}
              onClick={() => tx.run("Answer committed", "submit_job", { job_id: job.id, answer_hash: sha256Tagged(run!.responseBody), attestation: { text: run!.signature!.text, signature: run!.signature!.signature, signer: run!.signature!.signing_address } }, 0n, 60)}
            >
              2. Commit the answer
            </button>
            <button
              className="btn btn-line"
              disabled={!run || job.status !== "Answered" || !!verdict}
              onClick={async () => {
                const cfg = { name: hire!.name, model: hire!.model, systemPrompt: hire!.systemPrompt, tools: [] as string[] };
                const payload = JSON.stringify({ function: fn, title, tests, response: run!.responseBody, request: run!.requestBody, sealed: run!.sealed, config: cfg });
                const auth = await w.authHeaders("sealed", job.id, payload).catch((e) => ({ error: String(e instanceof Error ? e.message : e) }));
                if ("error" in auth) return setMsg(`Wallet: ${auth.error}`);
                const r = await fetch(`${__VERIFIER__}/jobs/${job.id}/sealed`, {
                  method: "POST",
                  headers: { "content-type": "application/json", ...auth },
                  body: payload,
                }).catch(() => null);
                const j = r ? await r.json().catch(() => ({})) : { error: "verifier unreachable" };
                if (r?.ok) setVerdict(j);
                setMsg(r?.ok ? `Verifier: ${j.score}/${j.totalTests}${j.check ? ` (${j.check})` : ""}, signed.` : `Verifier: ${j.error}`);
              }}
            >
              3. Score with the verifier
            </button>
            <button
              className="btn btn-line"
              disabled={!verdict || tx.busy}
              onClick={() => tx.run("Scores posted", "settle_job", { job_id: job.id, total_tests: verdict!.totalTests, score: verdict!.score, signatures: verdict!.signatures.slice(0, 2) }, 0n, 150)}
            >
              4. Post the signed score
            </button>
          </span>
          {run && <pre className="profile-pre">{run.content.slice(0, 1200)}</pre>}
        </>
      )}
      {msg && <p className="tx-status">{msg}</p>}
      <TxLine tx={tx} />
    </div>
  );
}

function Finalize({ job }: { job: Job }) {
  const tx = useTx();
  return (
    <div className="act">
      <span className="act-k">Job {job.id}: score posted</span>
      <span className="act-row">
        After the dispute window anyone can finalize: the agent is paid if it passed, otherwise you are refunded.
        <button className="btn btn-line" disabled={tx.busy} onClick={() => tx.run("Job finalized", "finalize_job", { job_id: job.id }, 0n, 150)}>
          Finalize
        </button>
      </span>
      <TxLine tx={tx} />
    </div>
  );
}

/** A scout's nomination: an agent and a curated tryout task from the brief's category, with a stake. */
function Nominate({ brief, identities, ratings, tasks }: { brief: Brief; identities: Identity[]; ratings: Rating[]; tasks: Task[] }) {
  const tx = useTx();
  const cat = CATEGORIES.find((c) => c.id === brief.category);
  const pool = tasks.filter((t) => t.curated && !t.retired && (!cat || cat.tasks.includes(t.task_ref)));
  const agents = [...identities].sort((a, b) => (ratings.find((r) => r.agent === b.agent)?.rating ?? 0) - (ratings.find((r) => r.agent === a.agent)?.rating ?? 0));
  const [agent, setAgent] = useState(agents[0]?.agent ?? "");
  const [task, setTask] = useState(pool[0]?.task_ref ?? "");
  const [stake, setStake] = useState(String(SCOUT_MIN_STAKE));
  const id = identities.find((i) => i.agent === agent);
  return (
    <div className="act">
      <span className="act-k">
        Brief {brief.id}
        {cat ? ` · ${cat.title}` : ""} · budget {near(brief.budget)} · reward {near(brief.scout_reward)}
      </span>
      <p className="brief-summary">“{brief.summary}”</p>
      <span className="act-row">
        {id && <Identicon cells={id.cells} palette={id.palette} size={22} />}
        <select className="lb-select" value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent">
          {agents.map((a) => (
            <option key={a.agent} value={a.agent}>
              {short(a.agent)} · {((ratings.find((r) => r.agent === a.agent)?.rating ?? 150000) / 100).toFixed(0)}
            </option>
          ))}
        </select>
        on
        <select className="lb-select" value={task} onChange={(e) => setTask(e.target.value)} aria-label="Tryout task">
          {pool.map((t) => (
            <option key={t.task_ref} value={t.task_ref}>
              {t.task_ref}
            </option>
          ))}
        </select>
        stake
        <input className="act-input" inputMode="decimal" value={stake} onChange={(e) => setStake(e.target.value)} aria-label="Stake in NEAR" /> NEAR
        <button className="btn btn-accent" disabled={!agent || !task || tx.busy} onClick={() => tx.run("Nominated", "nominate", { brief_id: brief.id, agent, task_ref: task }, yocto(stake))}>
          {tx.account ? "Nominate" : "Connect wallet"}
        </button>
      </span>
      <TxLine tx={tx} />
    </div>
  );
}
