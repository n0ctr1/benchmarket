import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { near, short, type Identity, type Rating, type Round } from "./chain";
import { Drawer } from "./Drawer";
import { Figure, type Pose } from "./Figure";
import { hueColor } from "./identity";
import { taskOf, type IdentityNotes, type RosterAgent, type RoundRecord } from "./offchain";
import { Passport, type LiveLine } from "./Passport";
import { Verify } from "./verify/Verify";
import { buildReplay, type Phase, type Replay } from "./replay";

const PHASES: Array<{ id: Phase; label: string; banner: string }> = [
  { id: "market", label: "Market", banner: "MARKET OPEN" },
  { id: "locked", label: "Locked", banner: "MARKET LOCKED" },
  { id: "solving", label: "Solving", banner: "SOLVING" },
  { id: "scored", label: "Scored", banner: "RUNNING HIDDEN TESTS" },
  { id: "window", label: "Dispute", banner: "DISPUTE WINDOW" },
  { id: "settled", label: "Settled", banner: "FINAL" },
];

const STEP_MS: Record<Phase, number> = { market: 1700, locked: 1600, solving: 900, scored: 2400, window: 1800, settled: 0 };

const SCOUT_FACES: Record<string, string> = {
  "scout-fav": "(^.^)",
  "scout-value": "($.$)",
  "scout-spec": "(o.O)",
  "scout-llm": "[*_*]",
};

interface Coin {
  key: number;
  fx: number;
  fy: number;
  tx: number;
  ty: number;
}

export function Arena({
  rounds,
  selected,
  onSelect,
  rec,
  roster,
  identities,
  ratings,
  notes,
}: {
  rounds: Round[];
  selected: Round;
  onSelect: (id: number) => void;
  rec: RoundRecord | null;
  roster: RosterAgent[];
  identities: Identity[];
  ratings: Rating[];
  notes: Record<string, IdentityNotes>;
}) {
  const round = selected;
  const [replay, setReplay] = useState<Replay | null>(null);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [reveal, setReveal] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [coin, setCoin] = useState<Coin | null>(null);
  const [confetti, setConfetti] = useState(0);
  const [verifying, setVerifying] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const scoutRefs = useRef(new Map<string, HTMLElement>());
  const slotRefs = useRef(new Map<string, HTMLElement>());
  const key = `${round.id}:${round.status}:${round.total_pool}:${rec?.events.length ?? 0}`;
  const lastRound = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    buildReplay(round, rec).then((r) => {
      if (!live) return;
      const fresh = lastRound.current !== round.id;
      lastRound.current = round.id;
      setReplay(r);
      if (fresh || !playing) {
        setIdx(r.frames.length - 1);
        setReveal(1);
        setPlaying(false);
      }
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Playback clock.
  useEffect(() => {
    if (!playing || !replay) return;
    const f = replay.frames[idx];
    if (idx >= replay.frames.length - 1) {
      setPlaying(false);
      if (f.phase === "settled") setConfetti((n) => n + 1);
      return;
    }
    if (f.phase === "scored") {
      setReveal(0);
      const started = performance.now();
      let raf = 0;
      const step = (t: number) => {
        const k = Math.min(1, (t - started) / (STEP_MS.scored - 300));
        setReveal(k);
        if (k < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
      const t = setTimeout(() => setIdx((i) => i + 1), STEP_MS.scored);
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(t);
      };
    }
    // Solving follows the real gaps between answers, compressed about 60x.
    const next = replay.frames[idx + 1];
    const ms = f.phase === "solving" && f.at && next?.at ? Math.min(2600, Math.max(600, (next.at - f.at) / 60)) : STEP_MS[f.phase];
    const t = setTimeout(() => setIdx((i) => i + 1), ms);
    return () => clearTimeout(t);
  }, [playing, idx, replay]);

  const frame = replay?.frames[Math.min(idx, (replay?.frames.length ?? 1) - 1)];
  const phase: Phase = frame?.phase ?? "market";
  const phaseIdx = PHASES.findIndex((p) => p.id === phase);
  const bets = replay?.bets ?? [];
  const betNow = playing && frame?.bet !== undefined ? bets[frame.bet] : undefined;

  // A coin flies from the scout to the agent it backs.
  useLayoutEffect(() => {
    if (!betNow || !stageRef.current) return;
    const s = scoutRefs.current.get(betNow.bettor);
    const t = slotRefs.current.get(betNow.agent);
    if (!s || !t) return;
    const base = stageRef.current.getBoundingClientRect();
    const a = s.getBoundingClientRect();
    const b = t.getBoundingClientRect();
    setCoin({
      key: Date.now(),
      fx: a.left + a.width / 2 - base.left,
      fy: a.top + a.height / 2 - base.top,
      tx: b.left + b.width / 2 - base.left,
      ty: b.top + 8 - base.top,
    });
  }, [betNow]);

  const task = taskOf(rec);
  const pool = frame ? frame.volume : BigInt(round.total_pool);
  const idOf = (acc: string) => identities.find((i) => i.agent === acc);
  const nameOf = (acc: string) => roster.find((r) => r.id === short(acc))?.name ?? short(acc);
  const scouts = [...new Map(bets.map((b) => [b.bettor, b.kind])).entries()];
  const lastFrame = idx === (replay?.frames.length ?? 1) - 1;
  const totalTests = round.total_tests || rec?.report?.totalTests || 0;

  const start = () => {
    if (!replay) return;
    setIdx(0);
    setReveal(0);
    setCoin(null);
    setPlaying(true);
  };

  // Per-agent view of the current frame, shared by the stage and the passports.
  const view = round.entries.map((e, i) => {
    const ans = rec?.agents[e.agent];
    const total = ans?.total ?? totalTests;
    const odds = phase === "market" && frame ? frame.odds[e.agent] ?? 0 : e.market_ppm / 1e6;
    const answered = frame?.answered.has(e.agent) ?? !!e.answer_hash;
    const settled = phase === "settled";
    const won = settled && round.winners.includes(e.agent);
    const timedOut = !e.answer_hash && (phase === "scored" || settled || (phase === "solving" && lastFrame));
    const pose: Pose = timedOut ? "out" : won ? "win" : settled ? "lose" : phase === "solving" && !answered ? "think" : "idle";
    const tests = ans?.tests ?? (e.score !== null ? Array.from({ length: total }, (_, k) => (k < e.score! ? 1 : 0)) : []);
    const shown = Math.round(tests.length * (settled ? 1 : reveal));
    const passed = tests.slice(0, shown).filter(Boolean).length;
    const latency = ans?.meta?.latencyMs ?? (e.answered_at_ms && round.locked_at_ms ? e.answered_at_ms - round.locked_at_ms : null);
    const showTests = phase === "scored" || phase === "window" || settled;
    let live: LiveLine;
    if (settled) live = { score: `${e.score ?? 0}/${total}`, delta: e.rating_delta / 100, state: won ? "winner" : timedOut ? "no answer" : undefined };
    else if (phase === "scored") live = { score: `${passed}/${total}`, state: "testing" };
    else if (phase === "window") live = { score: `${e.score ?? round.proposal?.scores[i]?.[1] ?? passed}/${total}`, state: round.status === "Disputed" ? "disputed" : "posted" };
    else if (phase === "solving") live = { state: answered ? "answered" : timedOut ? "timed out" : "thinking" };
    else if (phase === "locked") live = { odds: e.p_ppm / 1e6, state: "expected" };
    else live = { odds, state: "market" };
    return { e, i, ans, total, odds, answered, won, timedOut, pose, tests, shown, passed, latency, showTests, live };
  });

  const half = Math.ceil(view.length / 2);
  const passport = (v: (typeof view)[number]) => (
    <Passport
      key={v.e.agent}
      agent={v.e.agent}
      identity={idOf(v.e.agent)}
      roster={roster.find((r) => r.id === short(v.e.agent))}
      rating={ratings.find((r) => r.agent === v.e.agent)}
      notes={notes[v.e.agent]}
      live={v.live}
      active={hover === v.e.agent || v.won}
      onHover={setHover}
      onOpen={() => setOpen(v.e.agent)}
    />
  );
  const sorted = [...rounds].sort((a, b) => a.id - b.id);
  const openEntry = round.entries.find((e) => e.agent === open);
  const banner = PHASES[phaseIdx]?.banner ?? "";
  const scoring = phase === "scored" && view.length ? Math.round(reveal * Math.max(...view.map((v) => v.tests.length))) : 0;
  const shownBets = frame?.bet !== undefined ? frame.bet + 1 : phase === "market" && replay ? countBetsBefore(replay, idx) : bets.length;

  return (
    <section aria-label="Arena">
      <div className="arena-head">
        <div>
          <div className="round-kicker">
            <span>Round {String(round.id).padStart(2, "0")}</span>
            <span>·</span>
            <span>{round.skill}</span>
            <span className="status" data-s={round.status}>
              {round.status.toUpperCase()}
            </span>
            {round.market === "lmsr" && <span className="badge" title="Automated market maker (LMSR): prices are win probabilities">LMSR</span>}
            {round.attested && <span className="badge model" title="Every answer must carry a NEAR AI signature the contract verified">attested</span>}
            {round.market === "lmsr" && !round.rated && <span className="badge" title="Uncurated task: pays out, moves no rating">unrated</span>}
          </div>
          <h1 className="round-title">
            {task?.title ?? round.task_ref}
            {task && <span className="fn">{task.function}()</span>}
          </h1>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="k">Bounty</div>
            <div className="v">
              {near(round.bounty)}
              <small>NEAR</small>
            </div>
          </div>
          <div className="stat">
            <div className="k">{round.market === "lmsr" ? "Volume" : "Pool"}</div>
            <div className="v">
              {near(pool)}
              <small>NEAR</small>
            </div>
          </div>
          <div className="stat">
            <div className="k">Hidden tests</div>
            <div className="v">{totalTests || "—"}</div>
          </div>
          {round.market === "lmsr" && round.rated && (
            <div className="stat" title="Task difficulty: an agent rated the same is expected to pass half the tests">
              <div className="k">Task rating</div>
              <div className="v">{((round.task_rating_before + round.task_delta) / 100).toFixed(0)}</div>
            </div>
          )}
        </div>
      </div>

      <div className="round-picker" role="group" aria-label="Rounds">
        {sorted.map((r) => (
          <button key={r.id} aria-pressed={r.id === round.id} data-cancelled={r.status === "Cancelled"} onClick={() => onSelect(r.id)} title={`${r.task_ref} · ${r.status}`}>
            R{r.id}
          </button>
        ))}
      </div>

      <div className="track">
        <button className="play" onClick={start} disabled={!replay || playing}>
          <span className="glyph">{playing ? "■" : "▶"}</span>
          {playing ? "Replaying" : "Replay round"}
        </button>
        <div className="phases">
          {PHASES.map((p, i) => (
            <div key={p.id} className="phase" data-on={i < phaseIdx ? "done" : i === phaseIdx ? "now" : "todo"}>
              {p.label}
            </div>
          ))}
        </div>
        <div className="track-label" aria-live="polite">
          {frame?.label}
        </div>
        {(round.status === "Settled" || round.status === "Proposed" || round.status === "Disputed") && (
          <button className="play" onClick={() => setVerifying(true)} title="Re-check hashes, signatures and every score in this browser">
            <span className="glyph">✓</span>
            Re-check
          </button>
        )}
      </div>

      <div className="arena-grid">
        <div className="side side-l">{view.slice(0, half).map(passport)}</div>

        <div className="stage" ref={stageRef} data-phase={phase}>
          <div className="board mono">
            <span className="board-rule" />
            <span className="board-text" key={banner}>
              {banner}
              {phase === "scored" && scoring > 0 && <span className="muted"> · test {scoring}</span>}
            </span>
            <span className="board-rule" />
          </div>

          <div className="stands" data-dim={phaseIdx >= 1}>
            {scouts.length === 0 && <span className="muted stands-empty">no scouts this round</span>}
            {scouts.map(([s, kind]) => {
              const target = betNow?.bettor === s ? betNow : undefined;
              return (
                <div key={s} className="scout" data-betting={!!target} ref={(el) => void (el ? scoutRefs.current.set(s, el) : scoutRefs.current.delete(s))}>
                  {target && (
                    <div className="bubble" style={{ ["--agent" as string]: hueColor(idOf(target.agent)) }}>
                      <b>{nameOf(target.agent)}</b>
                      {target.amount > 0n && <> · {near(target.amount)} NEAR</>}
                      <span>{clip(target.reasoning ?? "", 120)}</span>
                    </div>
                  )}
                  <pre className="scout-face">{SCOUT_FACES[short(s)] ?? "(._.)"}</pre>
                  <div className="scout-name mono">
                    {short(s).replace("scout-", "")}
                    {kind === "llm" && <span className="scout-kind">model</span>}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="barrier mono" data-on={phaseIdx >= 1} aria-hidden="true">
            <span className="barrier-line" />
            <span className="barrier-text">[=] LOCKED</span>
            <span className="barrier-line" />
          </div>

          <div className="floor" style={{ ["--n" as string]: view.length }}>
            {view.map((v) => {
              const id = idOf(v.e.agent);
              const answeredNow = playing && phase === "solving" && frame?.label.startsWith(short(v.e.agent));
              const tag =
                phase === "market" ? (
                  `${(v.odds * 100).toFixed(1)}%`
                ) : phase === "settled" ? (
                  <Delta d={v.e.rating_delta / 100} />
                ) : v.showTests ? (
                  `${v.passed}/${v.total}`
                ) : (
                  `p ${(v.e.p_ppm / 1e4).toFixed(1)}%`
                );
              return (
                <button
                  key={v.e.agent}
                  className="slot"
                  data-win={v.won}
                  data-out={v.timedOut}
                  data-hover={hover === v.e.agent}
                  style={{ ["--agent" as string]: hueColor(id) }}
                  ref={(el) => void (el ? slotRefs.current.set(v.e.agent, el) : slotRefs.current.delete(v.e.agent))}
                  onMouseEnter={() => setHover(v.e.agent)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => setOpen(v.e.agent)}
                  aria-label={`${nameOf(v.e.agent)}: open details`}
                >
                  <span className="tag mono">{tag}</span>
                  <span className="thought mono" data-kind={v.pose === "think" ? "think" : answeredNow ? "sent" : "none"}>
                    {v.pose === "think" ? <Dots /> : answeredNow ? `sent${v.latency ? ` ${(v.latency / 1000).toFixed(0)}s` : ""}` : ""}
                  </span>
                  <Figure cells={id?.cells ?? []} palette={id?.palette} pose={id ? v.pose : "out"} seed={v.i + 1} />
                  <span className="podium mono" aria-hidden="true">
                    {v.won ? (round.winners.length > 1 ? "[ =1 ]" : "[ #1 ]") : ""}
                  </span>
                  <span className="plate">{nameOf(v.e.agent)}</span>
                  <span className="tests" aria-label={v.showTests ? `${v.e.score ?? 0} of ${v.total} tests passed` : `${v.total} hidden tests`}>
                    {Array.from({ length: Math.max(v.total, v.tests.length) }, (_, k) => (
                      <i key={k} data-r={v.showTests && k < v.shown ? String(v.tests[k] ?? 0) : undefined} />
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="ground" aria-hidden="true" />

          {coin && (
            <span
              key={coin.key}
              className="coin mono"
              style={{ ["--fx" as string]: `${coin.fx}px`, ["--fy" as string]: `${coin.fy}px`, ["--tx" as string]: `${coin.tx}px`, ["--ty" as string]: `${coin.ty}px` }}
              onAnimationEnd={() => setCoin(null)}
            >
              (N)
            </span>
          )}
          {confetti > 0 && <Confetti key={confetti} color={hueColor(idOf(round.winners[0] ?? ""))} />}
        </div>

        <div className="side side-r">{view.slice(half).map(passport)}</div>
      </div>

      {bets.length > 0 && (
        <div className="section" style={{ marginTop: 28 }}>
          <div className="section-head">
            <h2>Scouts' calls</h2>
            <span className="note">Purchases in the order they were made. Each scout saw the prices the earlier ones produced.</span>
          </div>
          <div className="booth">
            {bets.map((b, i) => (
              <article key={i} className="call" data-pending={i >= shownBets} data-now={frame?.bet === i} style={{ ["--agent" as string]: hueColor(idOf(b.agent)) }}>
                <div className="call-head">
                  <span className="mono muted">{SCOUT_FACES[short(b.bettor)] ?? "(._.)"}</span>
                  <span className="who">{short(b.bettor)}</span>
                  <span className="arrow">→</span>
                  <span className="pick">{nameOf(b.agent)}</span>
                  {b.amount > 0n && <span className="amt">{near(b.amount)} NEAR</span>}
                </div>
                <p>{b.reasoning}</p>
                <div style={{ marginTop: 10 }}>
                  <span className={`badge ${b.kind === "llm" ? "model" : ""}`}>{b.kind === "llm" ? "model" : "scripted"}</span>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}

      {verifying && <Verify key={round.id} round={round} onClose={() => setVerifying(false)} />}

      {openEntry && (
        <Drawer
          round={round}
          entry={openEntry}
          answer={rec?.agents[openEntry.agent]}
          agent={roster.find((r) => r.id === short(openEntry.agent))}
          identity={idOf(openEntry.agent)}
          notes={notes[openEntry.agent]}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}

function Delta({ d }: { d: number }) {
  return (
    <span className={`delta ${d >= 0 ? "up" : "down"}`}>
      {d >= 0 ? "+" : ""}
      {d.toFixed(1)}
    </span>
  );
}

function Dots() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((x) => (x + 1) % 4), 300);
    return () => clearInterval(t);
  }, []);
  return <>{"( " + ".".repeat(n).padEnd(3, " ") + " )"}</>;
}

const CONFETTI_CHARS = ["*", "+", ".", "o", "'", "`", "x", "~"];

function Confetti({ color }: { color: string }) {
  const bits = useRef(
    Array.from({ length: 46 }, (_, i) => ({
      c: CONFETTI_CHARS[i % CONFETTI_CHARS.length],
      x: Math.random() * 100,
      d: Math.random() * 500,
      t: 1400 + Math.random() * 1200,
      r: (Math.random() - 0.5) * 80,
      mine: Math.random() < 0.6,
    })),
  ).current;
  return (
    <div className="confetti mono" aria-hidden="true">
      {bits.map((b, i) => (
        <span
          key={i}
          style={{
            left: `${b.x}%`,
            animationDelay: `${b.d}ms`,
            animationDuration: `${b.t}ms`,
            color: b.mine ? color : "var(--text-muted)",
            ["--drift" as string]: `${b.r}px`,
          }}
        >
          {b.c}
        </span>
      ))}
    </div>
  );
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

function countBetsBefore(r: Replay, idx: number): number {
  let n = 0;
  for (let i = 0; i <= idx && i < r.frames.length; i++) if (r.frames[i].bet !== undefined) n = r.frames[i].bet! + 1;
  return n;
}
