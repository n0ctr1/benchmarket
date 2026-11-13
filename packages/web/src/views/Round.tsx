import { useEffect, useMemo, useRef, useState } from "react";
import { near, short, type Round } from "../chain";
import { lockPrice, pct, roundTitle, scoutFace, type Names } from "../league";
import type { RoundRecord } from "../offchain";
import { buildReplay, type Phase, type Replay } from "../replay";
import { Stage, type Scene } from "../stage/Stage";

const PHASES: Array<{ id: Phase; label: string; title: string }> = [
  { id: "market", label: "Market", title: "Market open" },
  { id: "locked", label: "Locked", title: "Market locked" },
  { id: "solving", label: "Solving", title: "Solving" },
  { id: "scored", label: "Scored", title: "Scored" },
  { id: "window", label: "Dispute", title: "Dispute window" },
  { id: "settled", label: "Final", title: "Final" },
];

const STEP_MS: Record<Phase, number> = { market: 1400, locked: 1800, solving: 1200, scored: 2600, window: 2400, settled: 0 };
const BET_MS = 2600;

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
    frameAt.current = performance.now();
  }

  // Playback clock: one frame of the real round at a time.
  useEffect(() => {
    if (!playing || !replay) return;
    const f = replay.frames[idx];
    if (idx >= replay.frames.length - 1) {
      setPlaying(false);
      return;
    }
    if (f.phase === "scored") {
      setReveal(0);
      const started = performance.now();
      let raf = 0;
      const step = (t: number) => {
        const k = Math.min(1, (t - started) / (STEP_MS.scored - 400));
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
    // Answers follow the real gaps between them, compressed about 60x.
    const next = replay.frames[idx + 1];
    const ms = f.bet !== undefined ? BET_MS : f.phase === "solving" && f.at && next?.at ? Math.min(2600, Math.max(900, (next.at - f.at) / 60)) : STEP_MS[f.phase];
    const t = setTimeout(() => setIdx((i) => i + 1), ms);
    return () => clearTimeout(t);
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
      const pickName = n.name(b.agent).toUpperCase();
      const e = round.entries.find((x) => x.agent === b.agent);
      const line = !placed ? "WATCHING" : scored && e ? `${pickName} · ${e.answer_hash ? `${e.score ?? 0}/${totalTests}` : "NO ANSWER"}` : `BET ON ${pickName} AT ${pct(paid[j] ?? 0)}`;
      return { id: short(s), face: scoutFace(s), line };
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
    setIdx(0);
    setReveal(0);
    setPlaying(true);
  };

  return (
    <>
      <div className="round-head">
        <div className="round-head-main">
          <div className="kicker">
            <button className="kicker-link" onClick={onLeague}>
              ← League
            </button>
            <span>·</span>
            <span className="accent">Round {round.id}</span>
            <span>·</span>
            <span>{round.skill}</span>
            {round.market === "lmsr" && <span>· {round.rated ? "rated" : "unrated"}</span>}
            {round.attested && <span>· attested</span>}
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
        </div>
        <div className="round-stats">
          <Stat k="Bounty" v={near(round.bounty)} />
          <Stat k={round.market === "lmsr" ? "Volume" : "Pool"} v={near(pool)} />
          <Stat k="Tests" v={String(totalTests || "—")} />
          {round.market === "lmsr" && round.rated && <Stat k="Task rating" v={((round.task_rating_before + round.task_delta) / 100).toFixed(0)} />}
        </div>
      </div>

      <div className="track">
        <button className="btn btn-accent" onClick={start} disabled={!replay || playing || cancelled}>
          {playing ? "Playing" : "▶ Replay"}
        </button>
        <div className="phases">
          {PHASES.map((p, i) => (
            <div key={p.id} className="phase" data-on={i < phaseIdx ? "done" : i === phaseIdx ? "now" : "todo"}>
              {p.label}
            </div>
          ))}
        </div>
      </div>

      <div className="stage">
        <Stage
          scene={scene}
          picked={picked ? round.entries.findIndex((e) => e.agent === picked) : null}
          onPick={(i) => onPick(round.entries[i].agent === picked ? null : round.entries[i].agent)}
          label={`Round ${round.id} in 3D, drawn in text: ${round.entries.length} agents on beams of light; the beam is the market price, then the score.`}
        />
        <div className="stage-hint">Click an agent for its passport</div>
      </div>

      <div className="banner" data-final={settled && round.winners.length > 0} aria-live="polite">
        <span className="banner-title">{title}</span>
        <span className="banner-text">{text}</span>
      </div>
    </>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="stat">
      <div className="stat-k">{k}</div>
      <div className="stat-v">{v}</div>
    </div>
  );
}
