import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { near, short, view, type Round } from "../chain";
import { lockPrice, pct, roundTitle, scoutFace, type Names } from "../league";
import type { RoundRecord } from "../offchain";
import { buildReplay, type Phase, type Replay } from "../replay";
import { Stage, type Scene } from "../stage/Stage";
import { clock } from "../stage/clock";
import { useTx } from "../wallet";
import { Timeline } from "./Timeline";
import type { LogEvent } from "../offchain";

const PHASES: Array<{ id: Phase; label: string; title: string }> = [
  { id: "market", label: "Market", title: "Market open" },
  { id: "locked", label: "Locked", title: "Market locked" },
  { id: "solving", label: "Solving", title: "Solving" },
  { id: "scored", label: "Scored", title: "Scored" },
  { id: "window", label: "Dispute", title: "Dispute window" },
  { id: "settled", label: "Final", title: "Final" },
];

// Long enough to read: a bet stays on screen while its scout's reasoning is shown.
const STEP_MS: Record<Phase, number> = { market: 2200, locked: 2600, solving: 1600, scored: 3400, window: 3200, settled: 0 };
const BET_MS = 4200;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export function RoundView({
  round,
  rounds,
  rec,
  n,
  picked,
  onPick,
  onSelect,
  onLeague,
  onVerify,
  autoplay,
  onStarted,
}: {
  round: Round;
  rounds: Round[];
  rec: RoundRecord | null;
  n: Names;
  picked: string | null;
  onPick: (agent: string | null) => void;
  onSelect: (id: number) => void;
  onLeague: () => void;
  onVerify: () => void;
  autoplay: boolean;
  onStarted: () => void;
}) {
  const [replay, setReplay] = useState<Replay | null>(null);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [reveal, setReveal] = useState(1);
  const frameAt = useRef(0);
  const lastRound = useRef<number | null>(null);
  const key = `${round.id}:${round.status}:${round.total_pool}:${rec?.events.length ?? 0}`;

  useEffect(() => {
    let live = true;
    buildReplay(round, rec).then((r) => {
      if (!live) return;
      const fresh = lastRound.current !== round.id;
      lastRound.current = round.id;
      setReplay(r);
      if (fresh && autoplay && round.status !== "Cancelled") {
        onStarted();
        setIdx(0);
        setReveal(0);
        setPlaying(true);
      } else if (fresh || !playing) {
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

  // When the shown frame changes, note the time: the stage times its motion from it.
  const shownIdx = useRef(-1);
  if (shownIdx.current !== idx) {
    shownIdx.current = idx;
    frameAt.current = clock.now();
  }
  const ctl = useSyncExternalStore(clock.subscribe, () => `${clock.paused}:${clock.speed}`);
  const paused = ctl.startsWith("true");
  const speed = Number(ctl.split(":")[1]);
  useEffect(() => () => clock.setPaused(false), []);

  const durationOf = (i: number): number => {
    const f = replay?.frames[i];
    if (!f) return 0;
    const next = replay!.frames[i + 1];
    // Answers follow the real gaps between them, compressed about 40x.
    return f.bet !== undefined ? BET_MS : f.phase === "solving" && f.at && next?.at ? Math.min(3200, Math.max(1300, (next.at - f.at) / 40)) : STEP_MS[f.phase];
  };

  // Playback: one frame of the real round at a time, on the replay clock (pause and speed apply).
  useEffect(() => {
    if (!playing || !replay) return;
    if (idx >= replay.frames.length - 1) {
      setPlaying(false);
      return;
    }
    const f = replay.frames[idx];
    let raf = 0;
    const tick = () => {
      const age = clock.now() - frameAt.current;
      if (f.phase === "scored") setReveal(Math.min(1, age / (STEP_MS.scored - 500)));
      if (age >= durationOf(idx)) setIdx((i) => i + 1);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, idx, replay]);

  const frames = replay?.frames ?? [];
  const frame = frames[Math.min(idx, frames.length - 1)];
  const phase: Phase = frame?.phase ?? "market";
  const phaseIdx = PHASES.findIndex((p) => p.id === phase);
  const bets = replay?.bets ?? [];
  const scouts = useMemo(() => [...new Set(bets.map((b) => b.bettor))], [bets]);
  const totalTests = round.total_tests || rec?.report?.totalTests || 0;
  const settled = phase === "settled";
  const scored = phase === "scored" || phase === "window" || settled;
  const cancelled = round.status === "Cancelled";
  const verifiable = round.status === "Settled" || round.status === "Proposed" || round.status === "Disputed";

  // Odds just before each bet, so a scout's line can say what it paid.
  const paid = useMemo(() => {
    const out: number[] = [];
    frames.forEach((f, i) => {
      if (f.bet !== undefined) out[f.bet] = frames[i - 1]?.odds[bets[f.bet].agent] ?? 0;
    });
    return out;
  }, [frames, bets]);
  const betsSoFar = frame?.bet !== undefined ? frame.bet + 1 : phase === "market" ? frames.slice(0, idx + 1).reduce((k, f) => (f.bet !== undefined ? f.bet + 1 : k), 0) : bets.length;

  const valueOf = (agent: string, i: number, f = frame) => {
    const e = round.entries[i];
    if (!f) return { value: 0, label: "" };
    if (f.phase === "scored" || f.phase === "window" || f.phase === "settled") {
      const ans = rec?.agents[agent];
      const total = ans?.total ?? totalTests;
      const tests = ans?.tests ?? (e.score !== null ? Array.from({ length: total }, (_, k) => (k < e.score! ? 1 : 0)) : []);
      const k = f.phase === "scored" ? reveal : 1;
      const shown = Math.round(tests.length * k);
      const passed = f.phase === "scored" ? tests.slice(0, shown).filter(Boolean).length : e.score ?? tests.filter(Boolean).length;
      if (!e.answer_hash) return { value: 0, label: "no answer" };
      return { value: total ? passed / total : 0, label: `${passed}/${total}` };
    }
    if (f.phase === "solving") return { value: f.odds[agent] ?? 0, label: f.answered.has(agent) ? "sent" : playing ? "···" : pct(f.odds[agent] ?? 0) };
    return { value: f.odds[agent] ?? 0, label: pct(f.odds[agent] ?? 0) };
  };

  const prevFrame = frames[idx - 1];
  const justAnswered = playing && phase === "solving" && frame && prevFrame ? [...frame.answered].find((a) => !prevFrame.answered.has(a)) : undefined;
  const scene: Scene = {
    agents: round.entries.map((e, i) => {
      const id = n.identity(e.agent);
      const v = valueOf(e.agent, i);
      const won = settled && round.winners.includes(e.agent);
      return {
        id: e.agent,
        name: n.name(e.agent),
        cells: id?.cells ?? [],
        palette: id?.palette,
        value: v.value,
        label: v.label,
        win: won,
        lost: settled && !won,
        scanAt: justAnswered === e.agent ? frameAt.current : undefined,
      };
    }),
    scouts: scouts.map((s) => {
      const j = bets.findIndex((b) => b.bettor === s);
      const b = bets[j];
      const placed = j < betsSoFar;
      const pickName = n.name(b.agent);
      const e = round.entries.find((x) => x.agent === b.agent);
      const line = !placed ? "watching" : scored && e ? `${pickName} · ${e.answer_hash ? `${e.score ?? 0}/${totalTests}` : "no answer"}` : `bet on ${pickName} at ${pct(paid[j] ?? 0)}`;
      const speaking = frame?.bet !== undefined && bets[frame.bet].bettor === s && !!bets[frame.bet].reasoning;
      return { id: short(s), face: scoutFace(s), line, says: speaking ? clip(bets[frame!.bet!].reasoning!, 220) : undefined };
    }),
    bet:
      playing && frame?.bet !== undefined
        ? (() => {
            const b = bets[frame.bet];
            const ai = round.entries.findIndex((e) => e.agent === b.agent);
            return { scout: scouts.indexOf(b.bettor), agent: ai, at: frameAt.current, before: valueOf(b.agent, ai, prevFrame) };
          })()
        : null,
    sweepAt: playing && phase === "window" ? frameAt.current : null,
    settled,
  };

  // The banner tells what is happening now, from the round's own data.
  let title = PHASES[phaseIdx]?.title ?? "";
  let text = frame?.label ?? "";
  if (cancelled) {
    title = "Cancelled";
    text = "The round was cancelled before scoring. Every stake was refunded.";
  } else if (phase === "market" && frame?.bet !== undefined) {
    const b = bets[frame.bet];
    title = `${short(b.bettor)} bets on ${n.name(b.agent)}`;
    const after = frame.odds[b.agent] ?? 0;
    text = `Bought at ${pct(paid[frame.bet] ?? 0)}${b.amount > 0n ? ` for ${near(b.amount)} NEAR` : ""}${b.reasoning ? `: “${clip(b.reasoning, 100)}”` : "."} ${n.name(b.agent)} moves to ${pct(after)}.`;
  } else if (phase === "market") {
    const first = frame ? Object.values(frame.odds)[0] ?? 0 : 0;
    text = bets.length ? `${frame?.label}. Every agent starts at ${pct(first)}; scouts buy one after another and each purchase moves the price.` : `${frame?.label}.`;
  } else if (phase === "locked") {
    const top = [...round.entries].sort((a, b) => b.market_ppm - a.market_ppm).slice(0, 3);
    text = `Prices frozen: ${top.map((e) => `${n.name(e.agent)} ${pct(e.market_ppm / 1e6)}`).join(", ")}. Now the agents answer.`;
  } else if (phase === "solving") {
    text = `${frame?.label}. Each answer's hash goes on chain before anyone can see it.`;
  } else if (phase === "scored") {
    text = `The verifier runs ${totalTests} hidden tests in a sandbox. Each beam is now the score, not the price.`;
  } else if (phase === "window") {
    title = round.dispute ? "Disputed" : "Dispute window";
    text = `${frame?.label}.`;
  } else if (settled) {
    const ws = round.winners;
    if (ws.length === 1) {
      const e = round.entries.find((x) => x.agent === ws[0])!;
      title = `${n.name(ws[0])} takes it`;
      text = `${e.score}/${totalTests} from ${pct(lockPrice(round, ws[0]))} at the lock. ${frame?.label}.`;
    } else if (ws.length > 1) {
      title = `${ws.map(n.name).join(" and ")} share it`;
      text = `Tied on the top score. ${frame?.label}.`;
    }
  }

  const sorted = [...rounds].sort((a, b) => a.id - b.id);
  const at = sorted.findIndex((r) => r.id === round.id);
  const prev = sorted[at - 1];
  const next = sorted[at + 1];
  const pool = frame ? frame.volume : BigInt(round.total_pool);

  const start = () => {
    if (!replay) return;
    onPick(null);
    clock.setPaused(false);
    setIdx(0);
    setReveal(0);
    setPlaying(true);
  };
  const stepTo = (i: number) => {
    if (!replay) return;
    const k = Math.max(0, Math.min(replay.frames.length - 1, i));
    setReveal(replay.frames[k].phase === "scored" ? 1 : 1);
    setIdx(k);
  };
  const [showLog, setShowLog] = useState(false);
  const seek = (e: LogEvent, i: number) => {
    if (!replay) return;
    const fs = replay.frames;
    const before = (rec?.events ?? []).slice(0, i).filter((x) => x.kind === "scout_bet").length;
    const find = (pred: (f: (typeof fs)[number]) => boolean) => Math.max(0, fs.findIndex(pred));
    let k = fs.length - 1;
    if (e.kind === "round_created") k = 0;
    else if (e.kind === "scout_bet") k = find((f) => f.bet === before);
    else if (e.kind === "answer_submitted" || e.kind === "answer_failed") k = find((f) => f.phase === "solving" && f.label.startsWith(short(e.data.agent)));
    else if (e.kind === "scores_proposed") k = find((f) => f.phase === "scored");
    else if (e.kind === "watcher_check" || e.kind === "disputed" || e.kind === "dispute_resolved") k = find((f) => f.phase === "window");
    setShowLog(false);
    clock.setPaused(true);
    setPlaying(true);
    stepTo(k);
  };

  // Acting on the round from a wallet: back an agent while the market trades, dispute posted scores.
  const tx = useTx();
  const [amount, setAmount] = useState("0.05");
  const [bond, setBond] = useState<bigint | null>(null);
  useEffect(() => {
    view<{ params?: { dispute_bond?: string } }>("get_config")
      .then((c) => c.params?.dispute_bond && setBond(BigInt(c.params.dispute_bond)))
      .catch(() => {});
  }, []);
  const yocto = (t: string) => {
    const m = /^(\d*)(?:\.(\d*))?$/.exec(t.trim());
    return m ? BigInt(m[1] || "0") * 10n ** 24n + BigInt((m[2] ?? "").slice(0, 24).padEnd(24, "0") || "0") : 0n;
  };
  const trading = round.status === "Trading" && Date.now() < round.bet_deadline_ms;
  const disputable = round.status === "Proposed" && !!round.proposal && Date.now() < round.proposal.dispute_until_ms;
  const pickedEntry = picked ? round.entries.find((e) => e.agent === picked) : undefined;

  return (
    <div className="round">
      <div className="round-head">
        <div className="round-head-main">
          <div className="crumbs">
            <button className="back-link" onClick={onLeague}>
              ← League
            </button>
            <span className="crumbs-sep">//</span>
            <span className="mono">Round {round.id}</span>
            <span className="round-nav">
              <button onClick={() => prev && onSelect(prev.id)} disabled={!prev} aria-label="Previous round">
                ‹
              </button>
              <button onClick={() => next && onSelect(next.id)} disabled={!next} aria-label="Next round">
                ›
              </button>
            </span>
          </div>
          <h1 className="round-title">{roundTitle(round, rec)}</h1>
          <div className="chips" aria-label="Round details">
            <span className="chip" data-s={round.status}>
              <i className="dot" />
              {round.status}
            </span>
            <span className="chip mono">{round.task_ref}</span>
            <span className="chip">{round.skill}</span>
            {round.market === "lmsr" ? <span className="chip">{round.rated ? "rated" : "unrated"}</span> : <span className="chip">rated</span>}
            <span className="chip">{round.market === "lmsr" ? "LMSR market" : "pool market"}</span>
            {round.attested && <span className="chip chip-info">attested answers</span>}
            {round.entries.some((e) => !n.roster(e.agent)) && <span className="chip chip-accent">open entry</span>}
            <span className="chip">{round.entries.length} agents</span>
          </div>
        </div>
        <div className="round-stats">
          <Stat k="Bounty" v={near(round.bounty)} u="NEAR" />
          <Stat k={round.market === "lmsr" ? "Volume" : "Pool"} v={near(pool)} u="NEAR" />
          <Stat k="Tests" v={String(totalTests || "—")} />
          {round.market === "lmsr" && round.rated && <Stat k="Task rating" v={((round.task_rating_before + round.task_delta) / 100).toFixed(0)} />}
        </div>
      </div>

      <div className="stage frame">
        <ol className="phases" aria-label="Round phases">
          {PHASES.map((p, i) => (
            <li key={p.id} className="phase" data-on={i < phaseIdx ? "done" : i === phaseIdx ? "now" : "todo"}>
              <span className="phase-n">{String(i + 1).padStart(2, "0")}</span>
              {p.label}
            </li>
          ))}
        </ol>
        <div className="frame-body">
          <Stage
            scene={scene}
            picked={picked ? round.entries.findIndex((e) => e.agent === picked) : null}
            onPick={(i) => onPick(round.entries[i].agent === picked ? null : round.entries[i].agent)}
            label={`Round ${round.id} in 3D, drawn in text: ${round.entries.length} agents on beams of light; the beam is the market price, then the score.`}
          />
          <div className="stage-hint">Hover an agent to outline it · click for its passport</div>
        </div>
      </div>

      <div className="dock" data-final={settled && round.winners.length > 0}>
        <div className="dock-actions">
          {playing ? (
            <button className="btn btn-accent" onClick={() => clock.setPaused(!paused)} aria-label={paused ? "Resume" : "Pause"}>
              <span aria-hidden="true">{paused ? "▶" : "❚❚"}</span> {paused ? "Resume" : "Pause"}
            </button>
          ) : (
            <button className="btn btn-accent" onClick={start} disabled={!replay || cancelled}>
              <span aria-hidden="true">▶</span> Replay
            </button>
          )}
          <span className="player" role="group" aria-label="Replay controls">
            <button onClick={() => (clock.setPaused(true), setPlaying(true), stepTo(idx - 1))} disabled={!replay || idx <= 0} aria-label="Previous step">
              ⏮
            </button>
            <button onClick={() => (clock.setPaused(true), setPlaying(true), stepTo(idx + 1))} disabled={!replay || idx >= frames.length - 1} aria-label="Next step">
              ⏭
            </button>
            {[0.5, 1, 2].map((v) => (
              <button key={v} aria-pressed={speed === v} onClick={() => clock.setSpeed(v)}>
                {v}×
              </button>
            ))}
            <span className="player-pos">
              {frames.length ? idx + 1 : 0}/{frames.length}
            </span>
          </span>
          {verifiable && (
            <button className="btn btn-line" onClick={onVerify} title="Re-check hashes, signatures and every score in this browser">
              <span aria-hidden="true">✓</span> Re-check
            </button>
          )}
        </div>
        <button className="banner" aria-live="polite" onClick={() => setShowLog(true)} title="Open the full timeline of this round">
          <span className="banner-title">{title}</span>
          <span className="banner-text">{text}</span>
          <span className="banner-more">Timeline →</span>
        </button>
      </div>

      {(trading || disputable || round.dispute) && (
        <div className="round-act">
          {trading && (
            <div className="act">
              <span className="act-k">Market open until {new Date(round.bet_deadline_ms).toISOString().slice(11, 16)} UTC</span>
              {pickedEntry ? (
                <span className="act-row">
                  Back <b>{n.name(pickedEntry.agent)}</b> at {pct(pickedEntry.odds_ppm / 1e6)} with
                  <input className="act-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount in NEAR" /> NEAR
                  <button className="btn btn-accent" disabled={tx.busy} onClick={() => tx.run(`Bought ${n.name(pickedEntry.agent)}`, "buy", { round_id: round.id, agent: pickedEntry.agent, min_shares: null }, yocto(amount))}>
                    {tx.account ? "Buy shares" : "Connect wallet"}
                  </button>
                </span>
              ) : (
                <span className="act-row muted">Click an agent on the stage to back it. A share pays 1 if that agent wins.</span>
              )}
            </div>
          )}
          {disputable && (
            <div className="act">
              <span className="act-k">Dispute window open until {new Date(round.proposal!.dispute_until_ms).toISOString().slice(11, 19)} UTC</span>
              <span className="act-row">
                Re-run the published answers first (Re-check). If a score is wrong, dispute it with a {bond !== null ? near(bond) : "…"} NEAR bond: arbiters re-run everything; a wrong score slashes the verifier and returns your bond.
                <button className="btn btn-line" disabled={tx.busy || bond === null} onClick={() => tx.run("Dispute filed", "dispute", { round_id: round.id }, bond ?? 0n)}>
                  {tx.account ? "Dispute scores" : "Connect wallet"}
                </button>
              </span>
            </div>
          )}
          {round.dispute && (
            <div className="act" data-kind="dispute">
              <span className="act-k">Disputed</span>
              <span className="act-row">
                {short(round.dispute.by)} disputed the posted scores with a {near(round.dispute.bond)} NEAR bond.{" "}
                {round.dispute.overturned === null ? "Arbiters are re-running the answers." : round.dispute.overturned ? "The arbiters overturned them: the verifier that signed them was slashed." : "The arbiters upheld them: the bond went to the league."}
              </span>
            </div>
          )}
          {(tx.error || tx.done) && (
            <span className="tx-status" data-kind={tx.error ? "error" : "done"}>
              {tx.error ?? `${tx.done}. The page updates within a few seconds.`}
            </span>
          )}
        </div>
      )}

      {showLog && <Timeline round={round} rec={rec} n={n} onSeek={seek} onClose={() => setShowLog(false)} />}
    </div>
  );
}

function Stat({ k, v, u }: { k: string; v: string; u?: string }) {
  return (
    <div className="stat">
      <div className="stat-k">{k}</div>
      <div className="stat-v">
        {v}
        {u && <small>{u}</small>}
      </div>
    </div>
  );
}
