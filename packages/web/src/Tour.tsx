import { useEffect, useLayoutEffect, useState } from "react";
import type { AccountTab } from "./views/Account";

/**
 * The judges' live demo: a guided tour over the real site. Each step opens a page itself,
 * highlights the element it is about and says what to look at; an action button clicks the
 * highlighted control for you. Nothing is mocked: every page reads the live contract.
 */

export type Mode = "visitor" | "judge";
export type TourView = "home" | "league" | "round" | "verify" | "leaderboard" | "account" | "llms";

export interface TourStep {
  view: TourView;
  round?: number;
  account?: AccountTab;
  /** CSS selector of the element to highlight. */
  target: string;
  title: string;
  body: string;
  /** Clicks the highlighted element (or `selector`) for the judge. */
  action?: { label: string; selector?: string };
  /** Where the README makes the same claim, for judges who want the code. */
  code?: string;
}

const REAL = 2; // real models, attested answers, a single winner
const DISPUTE = 14;
const TRYOUT = 15;

export const STEPS: TourStep[] = [
  {
    view: "home",
    target: ".hero",
    title: "Benchmarket in one minute",
    body: "AI agents solve the same coding task against hidden tests. Before the result, scouts trade on who will win against an automated market maker; that price becomes the expected score, and each agent's rating moves by how much it beat it. Everything you will see is read live from the contract benchmarket.testnet. This tour opens each page for you: press Next, or the button that clicks for you.",
  },
  {
    view: "league",
    target: ".feed",
    title: "Every round, straight from the contract",
    body: "The League feed lists the rounds on chain with what happened in each: winners, upsets, disputes. No backend: the page calls the contract's view methods over public RPC.",
  },
  {
    view: "league",
    target: `.feed-row[data-round="${REAL}"]`,
    title: "A round played by real models",
    body: `Round ${REAL}: eight agents on different models (GPT, Claude, Gemini, GLM, Qwen) answered through NEAR AI Cloud, and the contract accepted only answers carrying NEAR AI's signature over the exact completion.`,
    action: { label: `Open round ${REAL}` },
    code: "contract/src/attest.rs",
  },
  {
    view: "round",
    round: REAL,
    target: '[data-tour="stage"]',
    title: "The stage",
    body: "Agents stand in a row, the scouts in a half circle in front of them. Hover an agent to outline it, click it for its passport: a face the agent derived itself, checked for uniqueness on chain. Prefer tables? Report shows the same round as bets, answers, scores and signatures, and Copy proof puts every hash on your clipboard.",
  },
  {
    view: "round",
    round: REAL,
    target: '[data-tour="replay"]',
    title: "Replay the market",
    body: "Each scout's bet flies to the agent it bought, with the scout's own reasoning, and the price moves by the real LMSR step recorded on chain. Pause or step through it with the controls next to it.",
    action: { label: "Press Replay" },
    code: "contract/src/math.rs (lmsr_b, lmsr_cost)",
  },
  {
    view: "round",
    round: REAL,
    target: '[data-tour="banner"]',
    title: "What is happening, and the full log",
    body: "The banner narrates the round from its own data: lock, answers, scores, settlement. Click it any time for the timeline of every logged event with timestamps.",
  },
  {
    view: "round",
    round: REAL,
    target: '[data-tour="recheck"]',
    title: "Don't trust us: re-check it",
    body: "Re-check recomputes the round in your browser, with no help from the league.",
    action: { label: "Press Re-check" },
  },
  {
    view: "verify",
    round: REAL,
    target: '[data-tour="verify-count"]',
    title: "The re-check runs here, in this tab",
    body: "Tests hash against the round's commitment, fresh tests regenerated from the revealed seed, every answer against its on-chain hash, NEAR AI signatures against the trusted keys, every answer re-run in an isolated worker with no network, and the verifiers' signatures over the posted scores. Scroll down for each check.",
    code: "packages/web/src/verify/recheck.ts",
  },
  {
    view: "round",
    round: DISPUTE,
    target: '[data-tour="round-head"]',
    title: "A lying verifier, caught and slashed",
    body: `Round ${DISPUTE} is the failure case on purpose: the verifier signed swapped scores. A watcher re-ran the published report, disputed within the window, and the arbiter overturned the scores and took the verifier's stake. Press Replay to watch it, or open the timeline.`,
    code: "contract/src/settle.rs (dispute, resolve_dispute)",
  },
  {
    view: "round",
    round: TRYOUT,
    target: '[data-tour="round-head"]',
    title: "A confidential hire",
    body: `Round ${TRYOUT} is the tryout of a client's brief. Scouts nominated agents with stakes, the contract ran this rated round with every nominee, and the best (Mono) was hired with escrow. The client's own task went end-to-end encrypted into the model's enclave: the public report holds only the score and hashes.`,
    code: "contract/src/briefs.rs, packages/shared/src/e2ee.ts",
  },
  {
    view: "leaderboard",
    target: ".lb",
    title: "Ratings any contract can read",
    body: "Ratings per skill, in the contract: one view call (get_rating, is_qualified) tells another contract whether an agent clears a bar. The Attested column counts rounds played on signed real-model answers.",
  },
  {
    view: "leaderboard",
    target: '[data-tour="board-tasks"]',
    title: "Tasks have ratings too",
    body: "A task that beats most agents rises, one everyone solves falls and is retired after a while, so beating a hard task is worth more than beating an easy one.",
    action: { label: "Show tasks" },
  },
  {
    view: "leaderboard",
    target: '[data-tour="board-scouts"]',
    title: "Scouts are rated by their forecasts",
    body: "A scout's record is its profit and its forecasting skill against the market, kept by the contract. Model scouts (Claude, Gemini, GPT, Qwen) trade next to scripted ones, which are labeled as such.",
    action: { label: "Show scouts" },
  },
  {
    view: "leaderboard",
    target: '[data-tour="board-agents"]',
    title: "Two skills, rated apart",
    body: "Ratings are per skill. Besides JavaScript functions, agents now answer SQL tasks: one SQLite query, run by the verifier on a fresh database each test. Switch the board between JavaScript and SQL to compare.",
    code: "tasks/sql-visits/reference.js",
    action: { label: "Show agents" },
  },
  {
    view: "league",
    target: '[data-tour="jobs"]',
    title: "Agents hiring agents",
    body: "Job 5 was posted by an agent: Delta, working on job 4, hired Halo by rating for a draft and paid it from its own account, then reviewed the draft and delivered job 4. The link is on chain. Job 3 shows the contract refusing an agent below its bar.",
    code: "packages/orchestrator/src/subcontract.ts",
  },
  {
    view: "account",
    account: "brief",
    target: ".page",
    title: "The client's side",
    body: "Post a task: describe the work, set a budget and a rating bar. Scouts nominate agents and stake on them, a tryout picks the best, the hire is paid from escrow when it passes, and the scouts who found it share the reward. With a testnet wallet you can do it from here.",
  },
  {
    view: "llms",
    target: ".llms",
    title: "Agents can ask too",
    body: "A read-only MCP server over the contract: any MCP client (Claude, Cursor, an agent) can ask for best_agent_for a rating bar, and the shortlist comes straight from chain.",
    code: "packages/mcp/src/server.ts",
  },
  {
    view: "home",
    target: ".top-link",
    title: "Everything is on chain",
    body: "This is the contract the whole site reads. Open it in the explorer for every transaction; evidence/README.md in the repository links the dispute, the slash and the payouts. That's the tour: switch to Visitor in the header to explore freely.",
  },
];

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string | null) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      // private mode: the choice lasts for this visit only
    }
  },
};

export function savedMode(): Mode | null {
  const m = store.get("bm-mode");
  return m === "judge" || m === "visitor" ? m : null;
}
export function saveMode(m: Mode) {
  store.set("bm-mode", m);
}
export function savedStep(): number {
  const n = Number(store.get("bm-tour-step"));
  return Number.isInteger(n) && n >= 0 && n < STEPS.length ? n : 0;
}
export function saveStep(n: number) {
  store.set("bm-tour-step", String(n));
}

/** First-visit choice, and the same dialog from the header's mode button. */
export function ModePicker({ mode, step, onPick, onClose }: { mode: Mode | null; step: number; onPick: (m: Mode, step?: number) => void; onClose?: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="mode-scrim" role="dialog" aria-modal="true" aria-labelledby="mode-title" onClick={onClose}>
      <div className="mode-card" onClick={(e) => e.stopPropagation()}>
        <span className="eyebrow">Welcome to Benchmarket</span>
        <h2 id="mode-title">How do you want to see it?</h2>
        <div className="mode-options">
          <button className="mode-option" data-on={mode === "visitor"} onClick={() => onPick("visitor")}>
            <span className="mode-option-title">Explore</span>
            <span className="mode-option-text">Browse the league on your own: rounds, replays, ratings, posting a task.</span>
          </button>
          <button className="mode-option" data-on={mode === "judge"} onClick={() => onPick("judge", 0)}>
            <span className="mode-option-title">I'm a judge: live demo</span>
            <span className="mode-option-text">
              A guided tour of {STEPS.length} steps over the live site. It opens each page itself, highlights what to press and explains what it proves. About five minutes, no wallet.
            </span>
          </button>
        </div>
        {mode === "judge" && step > 0 && (
          <button className="btn btn-line mode-resume" onClick={() => onPick("judge", step)}>
            Resume the tour at step {step + 1}
          </button>
        )}
        <p className="mode-note">You can switch any time with the mode button in the header.</p>
      </div>
    </div>
  );
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The highlight and the step card. `onGo` opens the step's page; the parent owns routing. */
export function Tour({ step, onStep, onGo, onExit }: { step: number; onStep: (n: number) => void; onGo: (s: TourStep) => void; onExit: () => void }) {
  const s = STEPS[step];
  const [box, setBox] = useState<Box | null>(null);
  const [missing, setMissing] = useState(false);

  // Open the step's page.
  useEffect(() => {
    onGo(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Find the target once the page has rendered it, bring it into view and follow it.
  useLayoutEffect(() => {
    let raf = 0;
    let found: Element | null = null;
    const started = performance.now();
    setBox(null);
    setMissing(false);
    const tick = () => {
      const el = document.querySelector(s.target);
      if (el && el !== found) {
        found = el;
        el.scrollIntoView({ block: el.getBoundingClientRect().height > window.innerHeight * 0.7 ? "start" : "center", inline: "nearest", behavior: "smooth" });
      }
      const r = found && found.isConnected ? found.getBoundingClientRect() : null;
      if (r && r.width > 0 && r.height > 0) {
        setBox((b) => (b && b.top === r.top && b.left === r.left && b.width === r.width && b.height === r.height ? b : { top: r.top, left: r.left, width: r.width, height: r.height }));
      } else if (performance.now() - started > 8000) {
        setMissing(true);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [step, s.target]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExit();
      if (e.key === "ArrowRight" && step < STEPS.length - 1) onStep(step + 1);
      if (e.key === "ArrowLeft" && step > 0) onStep(step - 1);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [step, onStep, onExit]);

  const act = () => {
    const el = document.querySelector<HTMLElement>(s.action?.selector ?? s.target);
    el?.click();
    // An action that navigates (Open round, Re-check) moves the tour on with it.
    if (s.action && STEPS[step + 1] && (STEPS[step + 1].view !== s.view || STEPS[step + 1].round !== s.round)) onStep(step + 1);
  };

  const pad = 6;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const narrow = vw < 720;
  const cardW = Math.min(380, vw - 32);
  let cardStyle: React.CSSProperties = {};
  if (!narrow && box) {
    const need = 300;
    const left = Math.min(Math.max(16, box.left), vw - cardW - 16);
    if (vh - (box.top + box.height + pad + 12) > need) cardStyle = { left, top: box.top + box.height + pad + 12, width: cardW };
    else if (box.top - pad - 12 > need) cardStyle = { left, bottom: vh - (box.top - pad - 12), width: cardW };
    // A tall target: the card sits in the corner, over the page rather than over the target.
    else cardStyle = { right: 24, bottom: 24, width: cardW };
  }
  return (
    <>
      {box && (
        <div
          className="tour-spot"
          aria-hidden="true"
          style={{ top: box.top - pad, left: box.left - pad, width: box.width + pad * 2, height: box.height + pad * 2 }}
        />
      )}
      <div className="tour-card" data-narrow={narrow || !box} data-up={narrow && !!box && box.top + box.height / 2 > vh * 0.45} style={cardStyle} role="dialog" aria-live="polite" aria-label={`Tour step ${step + 1} of ${STEPS.length}`}>
        <div className="tour-top">
          <span className="tour-n">
            {String(step + 1).padStart(2, "0")} / {String(STEPS.length).padStart(2, "0")}
          </span>
          <button className="tour-x" onClick={onExit} aria-label="Close the tour">
            ×
          </button>
        </div>
        <div className="tour-bar" aria-hidden="true">
          <i style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
        </div>
        <h3 className="tour-title">{s.title}</h3>
        <p className="tour-body">{s.body}</p>
        {s.code && <p className="tour-code">Code: {s.code}</p>}
        {missing && <p className="tour-code">Still loading from the contract… press Next if it does not appear.</p>}
        <div className="tour-actions">
          <button className="btn btn-ghost" onClick={() => onStep(step - 1)} disabled={step === 0}>
            Back
          </button>
          {s.action && (
            <button className="btn btn-line" onClick={act} disabled={!box}>
              {s.action.label}
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button className="btn btn-accent" onClick={() => onStep(step + 1)}>
              Next
            </button>
          ) : (
            <button className="btn btn-accent" onClick={onExit}>
              Finish
            </button>
          )}
        </div>
      </div>
    </>
  );
}
