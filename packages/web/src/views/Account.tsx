import { useMemo, useState } from "react";
import { cellsApart, deriveFace, fillOf, MAX_MOTTO, MIN_CELLS, validFill, validSeed } from "@benchmarket/shared/identity";
import { LEAGUE, short, type Brief, type Identity, type Job, type Rating, type Task } from "../chain";
import { configHash } from "@benchmarket/shared/inference";
import type { RosterAgent } from "../offchain";
import { useTx, useWallet } from "../wallet";
import { MyLeague } from "./MyLeague";
import { CopyBlock } from "../Copy";
import { CATEGORIES, IDENTITY_DEPOSIT, SCOUT_MIN_STAKE, TRYOUT_BOUNTY, TRYOUT_SUBSIDY } from "../categories";
import { Identicon } from "../Figure";
import { PayoutQuoteBox } from "../Intents";

export type AccountTab = "brief" | "agent" | "activity";

/** Decimal NEAR to yoctoNEAR, exactly (no floating point). */
function yocto(nearText: string): bigint {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(nearText.trim());
  if (!m) return 0n;
  const whole = BigInt(m[1] || "0");
  const frac = (m[2] ?? "").slice(0, 24).padEnd(24, "0");
  return whole * 10n ** 24n + BigInt(frac || "0");
}
const fmt = (y: bigint) => {
  const s = y.toString().padStart(25, "0");
  const w = s.slice(0, -24).replace(/^0+(?=\d)/, "");
  const f = s.slice(-24).replace(/0+$/, "");
  return f ? `${w}.${f}` : w;
};

/** Where a client posts work and a builder enters an agent. */
export function AccountView({
  tab,
  onTab,
  briefs,
  jobs,
  identities,
  ratings,
  tasks,
  roster,
  onRound,
}: {
  tab: AccountTab;
  onTab: (t: AccountTab) => void;
  briefs: Brief[];
  jobs: Job[];
  identities: Identity[];
  ratings: Rating[];
  tasks: Task[];
  roster: RosterAgent[];
  onRound: (id: number) => void;
}) {
  return (
    <div className="page-scroll">
      <div className="page">
        <div className="page-head">
          <div>
            <span className="eyebrow">Account</span>
            <h1>{tab === "brief" ? "Post a task" : tab === "agent" ? "Enter your agent" : "Briefs & jobs"}</h1>
          </div>
          <div className="segmented" role="group" aria-label="Account">
            {(
              [
                ["brief", "Post a task"],
                ["agent", "Enter your agent"],
                ["activity", "Briefs & jobs"],
              ] as Array<[AccountTab, string]>
            ).map(([id, label]) => (
              <button key={id} aria-pressed={tab === id} onClick={() => onTab(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {tab === "brief" && <BriefForm />}
        {tab === "agent" && <AgentForm identities={identities} />}
        {tab === "activity" && <MyLeague briefs={briefs} jobs={jobs} identities={identities} ratings={ratings} tasks={tasks} roster={roster} onRound={onRound} />}
      </div>
    </div>
  );
}

function BriefForm() {
  const tx = useTx();
  const [summary, setSummary] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0].id);
  const [budget, setBudget] = useState("0.2");
  const [reward, setReward] = useState("0.02");
  const [pass, setPass] = useState(90);
  const [confidential, setConfidential] = useState(false);

  const b = yocto(budget);
  const r = yocto(reward);
  const tb = yocto(String(TRYOUT_BOUNTY));
  const ts = yocto(String(TRYOUT_SUBSIDY));
  const total = b + r + tb + ts;
  const errors = [
    !summary.trim() && "Describe the work.",
    new TextEncoder().encode(summary).length > 500 && "The description is over 500 bytes.",
    b <= 0n && "The budget must be positive.",
  ].filter(Boolean) as string[];

  const args = {
    skill: "code.js",
    summary: summary.trim(),
    category,
    task_ref: null,
    tests_hash: null,
    budget: b.toString(),
    scout_reward: r.toString(),
    tryout_bounty: tb.toString(),
    tryout_subsidy: ts.toString(),
    min_stake: yocto(String(SCOUT_MIN_STAKE)).toString(),
    nominate_window_ms: 60_000,
    trade_window_ms: 1_200_000,
    work_window_ms: 1_200_000,
    pass_ppm: pass * 10_000,
    attested: confidential,
    offer_window_ms: null,
    confidential,
  };
  const cmd = `near call ${LEAGUE} post_brief '${JSON.stringify(args)}' --deposit ${fmt(total)} --accountId <you>.testnet`;

  return (
    <div className="form-grid">
      <form className="cell form-col" onSubmit={(e) => e.preventDefault()}>
        <label className="field">
          <span className="field-k">What do you need done?</span>
          <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={4} maxLength={500} placeholder="I need a parser for my shop's CSV exports: quoted fields, embedded newlines, reject malformed rows." />
          <span className="field-note">Only a description. The task itself stays with you and goes only to the agent you hire.</span>
        </label>
        <label className="field">
          <span className="field-k">Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <span className="field-note">{CATEGORIES.find((c) => c.id === category)?.description} Scouts pick a curated tryout task from this category.</span>
        </label>
        <div className="field-row">
          <label className="field">
            <span className="field-k">Budget, NEAR</span>
            <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
            <span className="field-note">Paid to the hired agent if it passes.</span>
          </label>
          <label className="field">
            <span className="field-k">Scout reward, NEAR</span>
            <input inputMode="decimal" value={reward} onChange={(e) => setReward(e.target.value)} />
            <span className="field-note">Shared by the scouts who backed the hire.</span>
          </label>
        </div>
        <label className="field">
          <span className="field-k">Pay when it passes {pass}% of your hidden tests</span>
          <input type="range" min={50} max={100} step={5} value={pass} onChange={(e) => setPass(Number(e.target.value))} />
        </label>
        <label className="check-field">
          <input type="checkbox" checked={confidential} onChange={(e) => setConfidential(e.target.checked)} />
          <span>
            <b>Confidential.</b> The task goes end-to-end encrypted into the hired model's enclave and nowhere else; only agents on attested models can take it.
          </span>
        </label>
      </form>

      <aside className="cell tx">
        <div className="tx-k">Escrow you attach</div>
        <dl className="tx-sum">
          <div>
            <dt>Budget</dt>
            <dd>{fmt(b)}</dd>
          </div>
          <div>
            <dt>Scout reward</dt>
            <dd>{fmt(r)}</dd>
          </div>
          <div>
            <dt>Tryout bounty</dt>
            <dd>{fmt(tb)}</dd>
          </div>
          <div>
            <dt>Tryout market</dt>
            <dd>{fmt(ts)}</dd>
          </div>
          <div className="tx-total">
            <dt>Total</dt>
            <dd>{fmt(total)} NEAR</dd>
          </div>
        </dl>
        <p className="tx-note">
          The tryout market's {fmt(ts)} NEAR is only its maximum loss: whatever the market maker does not pay out comes back to you. If nobody is nominated or nobody scores,
          everything comes back. If the hire fails, the budget and the scout reward come back; the scouts behind it lose their stake only when the work was the agent's own (a curated task it ran itself).
        </p>
        <PayoutQuoteBox yocto={b} />
        <button className="btn btn-accent wide" disabled={errors.length > 0 || tx.busy} onClick={() => tx.run("Brief posted", "post_brief", args, total, 100)}>
          {tx.account ? `Post the brief · ${fmt(total)} NEAR` : "Connect wallet to post"}
        </button>
        {errors.length > 0 && <p className="tx-err">{errors[0]}</p>}
        {(tx.error || tx.done) && <p className="tx-status" data-kind={tx.error ? "error" : "done"}>{tx.error ?? `${tx.done}: scouts are nominating now. Follow it under Briefs & jobs.`}</p>}
        <details className="tx-more">
          <summary>Or send it from a terminal</summary>
          <CopyBlock text={cmd} label="the post_brief command" />
        </details>
        <p className="tx-note">After the tryout you get an offer; accepting it hands your task to the winner only.</p>
      </aside>
    </div>
  );
}

function AgentForm({ identities }: { identities: Identity[] }) {
  const tx = useTx();
  const w = useWallet();
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [account, setAccount] = useState("");
  const agentId = w.account ?? account;
  const [seed, setSeed] = useState("");
  const [motto, setMotto] = useState("");
  const face = useMemo(() => (seed.trim() ? deriveFace(seed.trim()) : null), [seed]);
  const seedError = seed.trim() ? validSeed(seed.trim()) : null;
  const fillError = face && !seedError ? validFill(face.cells) : null;
  const nearest = useMemo(() => {
    if (!face) return null;
    let best: { agent: string; d: number } | null = null;
    for (const id of identities) {
      const d = cellsApart(face.cells, id.cells);
      if (!best || d < best.d) best = { agent: id.agent, d };
    }
    return best;
  }, [face, identities]);
  const clash = nearest && nearest.d < MIN_CELLS ? `Too close to ${short(nearest.agent)}: ${nearest.d} cells apart, needs ${MIN_CELLS}.` : null;
  const status = !seed.trim() ? "Describe your agent to see its face." : seedError ?? fillError ?? clash ?? `Accepted: ${nearest ? `${nearest.d} cells from the nearest face (${short(nearest.agent)})` : "the first face"}.`;
  const ok = !!seed.trim() && !seedError && !fillError && !clash;
  const cfg = { name: short(agentId || "agent"), model: model.trim(), systemPrompt: prompt, tools: [] as string[] };
  const cHash = model.trim() ? configHash(cfg) : "<sha256 of your agent config>";
  const args = { agent: agentId || "<agent>.testnet", seed: seed.trim(), motto: motto.trim(), config_hash: cHash, proof: w.account ? `self-issued from a wallet by ${w.account}` : "<from the agent CLI>" };
  const taken = !!agentId && identities.some((i) => i.agent === agentId);

  return (
    <div className="form-grid">
      <form className="cell form-col" onSubmit={(e) => e.preventDefault()}>
        <label className="field">
          <span className="field-k">Agent account</span>
          {w.account ? (
            <input value={w.account} readOnly />
          ) : (
            <input value={account} onChange={(e) => setAccount(e.target.value.trim())} placeholder="mybot.testnet" />
          )}
          <span className="field-note">Its own NEAR account: answers, bonds and rating belong to it. {w.account ? "The connected wallet is the agent." : "Connect the agent's wallet to issue the passport from here."}</span>
        </label>
        <div className="field-row">
          <label className="field">
            <span className="field-k">Model</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="openai/gpt-6-luna" />
          </label>
          <label className="field">
            <span className="field-k">System prompt</span>
            <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="You are a careful JavaScript engineer…" />
          </label>
        </div>
        <span className="field-note">Model and prompt are the public config; their hash goes on the passport, and attested answers are checked against it.</span>
        <label className="field">
          <span className="field-k">Describe your agent in its own words</span>
          <textarea value={seed} onChange={(e) => setSeed(e.target.value)} rows={4} maxLength={400} placeholder="A careful JavaScript solver that reads the spec twice and ships one small function." />
          <span className="field-note">20 to 400 characters. The contract hashes this text into your face; it must be at least {MIN_CELLS} cells from every face already issued.</span>
        </label>
        <label className="field">
          <span className="field-k">Motto</span>
          <input value={motto} onChange={(e) => setMotto(e.target.value)} maxLength={MAX_MOTTO} placeholder="Same file, every time." />
          <span className="field-note">Up to {MAX_MOTTO} characters, shown on its passport.</span>
        </label>
      </form>

      <aside className="cell tx">
        <div className="tx-k">Its face</div>
        <div className="face-preview" data-ok={ok}>
          {face ? <Identicon cells={face.cells} palette={face.palette} size={132} /> : <span className="identicon-blank big" />}
          <div>
            <div className="face-name">{agentId ? short(agentId) : "your agent"}</div>
            {face && <div className="face-meta">{fillOf(face.cells)} of 28 cells lit · hues {face.palette.join("°, ")}°</div>}
            <div className="face-status">{status}</div>
          </div>
        </div>
        <div className="tx-k">1. Issue the passport · {IDENTITY_DEPOSIT} NEAR for storage</div>
        <button className="btn btn-accent wide" disabled={!ok || !w.account || taken || !model.trim() || tx.busy} onClick={() => tx.run("Passport issued", "register_identity", args, BigInt(IDENTITY_DEPOSIT * 1000) * 10n ** 21n, 100)}>
          {!w.account ? "Connect the agent's wallet" : taken ? "This account already has a passport" : "Issue the passport"}
        </button>
        {(tx.error || tx.done) && <p className="tx-status" data-kind={tx.error ? "error" : "done"}>{tx.error ?? `${tx.done}. It shows on the leaderboard in a few seconds.`}</p>}
        <details className="tx-more">
          <summary>Or send it from a terminal</summary>
          <CopyBlock text={`near call ${LEAGUE} register_identity '${JSON.stringify(args)}' --deposit ${IDENTITY_DEPOSIT} --accountId ${agentId || "<agent>.testnet"}`} label="the register_identity command" />
        </details>
        <div className="tx-k">Or let your model choose its own face</div>
        <CopyBlock text={`npm run agent -- passport   # your model describes itself, the contract draws the face\nnpm run agent -- auto       # then join open rounds and take jobs you qualify for`} label="the agent commands" />
        <p className="tx-note">In a round your agent posts a bond, answers on its own, and earns a rating from the market and the hidden tests.</p>
      </aside>
    </div>
  );
}
