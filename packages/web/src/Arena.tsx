import { useEffect, useRef, useState } from "react";
import { near, short, type Round } from "./chain";
import { Drawer, signatureLabel } from "./Drawer";
import { taskOf, type RosterAgent, type RoundRecord } from "./offchain";
import { buildReplay, share, type Phase, type Replay } from "./replay";
import { Robot } from "./Robot";
import { colorOf } from "./robots";

const PHASES: Array<{ id: Phase; label: string }> = [
  { id: "market", label: "Market" },
  { id: "locked", label: "Locked" },
  { id: "solving", label: "Solving" },
  { id: "scored", label: "Scored" },
  { id: "settled", label: "Settled" },
];

const STEP_MS: Record<Phase, number> = { market: 1300, locked: 1400, solving: 900, scored: 1900, settled: 0 };

export function Arena({
  rounds,
  selected,
  onSelect,
  rec,
  roster,
}: {
  rounds: Round[];
  selected: Round;
  onSelect: (id: number) => void;
  rec: RoundRecord | null;
  roster: RosterAgent[];
}) {
  const round = selected;
  const [replay, setReplay] = useState<Replay | null>(null);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [reveal, setReveal] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const key = `${round.id}:${round.status}:${round.total_pool}:${rec?.events.length ?? 0}`;
  const lastKey = useRef("");

  useEffect(() => {
    let live = true;
    buildReplay(round, rec).then((r) => {
      if (!live) return;
      const fresh = lastKey.current.split(":")[0] !== String(round.id);
      lastKey.current = key;
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

  // Playback.
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
    const ms = f.phase === "solving" && f.at && next?.at ? Math.min(2600, Math.max(500, (next.at - f.at) / 60)) : STEP_MS[f.phase];
    const t = setTimeout(() => setIdx((i) => i + 1), ms);
    return () => clearTimeout(t);
  }, [playing, idx, replay]);

  const task = taskOf(rec);
  const frame = replay?.frames[Math.min(idx, (replay?.frames.length ?? 1) - 1)];
  const phase: Phase = frame?.phase ?? "market";
  const phaseIdx = PHASES.findIndex((p) => p.id === phase);
  const bets = replay?.bets ?? [];
  const betsShown = frame ? (frame.bet !== undefined ? frame.bet + 1 : phase === "market" ? countBetsBefore(replay!, idx) : bets.length) : 0;
  const pool = frame ? Object.values(frame.pools).reduce((a, b) => a + b, 0n) : BigInt(round.total_pool);
  const nameOf = (acc: string) => roster.find((r) => r.id === short(acc))?.name ?? short(acc);

  const start = () => {
    if (!replay) return;
    setIdx(0);
    setReveal(0);
    setPlaying(true);
  };

  const sorted = [...rounds].sort((a, b) => a.id - b.id);
  const openEntry = round.entries.find((e) => e.agent === open);

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
            <div className="k">Pool</div>
            <div className="v">
              {near(pool)}
              <small>NEAR</small>
            </div>
          </div>
          <div className="stat">
            <div className="k">Hidden tests</div>
            <div className="v">{round.total_tests || rec?.report?.totalTests || "—"}</div>
          </div>
        </div>
      </div>

      <div className="round-picker" role="group" aria-label="Rounds">
        {sorted.map((r) => (
          <button
            key={r.id}
            aria-pressed={r.id === round.id}
            data-cancelled={r.status === "Cancelled"}
            onClick={() => onSelect(r.id)}
            title={`${r.task_ref} · ${r.status}`}
          >
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
      </div>

      <div className="lanes" style={{ ["--n" as string]: round.entries.length }}>
        {round.entries.map((e) => {
          const id = short(e.agent);
          const ans = rec?.agents[e.agent];
          const total = ans?.total ?? round.total_tests ?? 0;
          const odds = phase === "market" && frame ? share(frame.pools, e.agent) : e.market_ppm / 1e6;
          const answered = frame?.answered.has(e.agent) ?? !!e.answer_hash;
          const settled = phase === "settled";
          const won = settled && round.winner === e.agent;
          const noAnswer = !e.answer_hash && (phase === "scored" || settled || (phase === "solving" && idx === replay!.frames.length - 1));
          const mood = noAnswer ? "out" : won ? "win" : settled ? "lose" : phase === "solving" && !answered ? "think" : "idle";
          const showTests = phase === "scored" || settled;
          const tests = ans?.tests ?? (e.score !== null ? Array.from({ length: total }, (_, i) => (i < e.score! ? 1 : 0)) : []);
          const shown = Math.round(tests.length * (settled ? 1 : reveal));
          const sig = answered && phase !== "market" && phase !== "locked" ? signatureLabel(ans) : "";
          const latency = ans?.meta?.latencyMs ?? (e.answered_at_ms && round.locked_at_ms ? e.answered_at_ms - round.locked_at_ms : null);
          return (
            <button
              key={e.agent}
              className="lane"
              data-win={won}
              data-out={noAnswer}
              style={{ ["--agent" as string]: colorOf(id) }}
              onClick={() => setOpen(e.agent)}
              aria-label={`${nameOf(e.agent)}: open details`}
            >
              <div className="lane-top">
                <span className="lane-name">{nameOf(e.agent)}</span>
                {won ? <span className="badge win">Winner</span> : noAnswer ? <span className="badge">No answer</span> : sig && <span className="badge">{sig}</span>}
              </div>
              <div className="lane-model">{roster.find((r) => r.id === id)?.model ?? e.agent}</div>
              <Robot id={id} mood={mood} />
              <div className="odds">
                <span className="big">{(odds * 100).toFixed(1)}%</span>
                <span className="p">
                  {phase === "market" ? "market" : <>expected {(e.p_ppm / 1e4).toFixed(1)}%</>}
                </span>
              </div>
              <div className="bar">
                <span style={{ width: `${Math.min(100, odds * 100 * 1.6)}%` }} />
              </div>
              <div className="tests" aria-label={showTests ? `${e.score ?? 0} of ${total} tests passed` : `${total} hidden tests`}>
                {Array.from({ length: Math.max(total, tests.length) }, (_, i) => (
                  <i key={i} data-r={showTests && i < shown ? String(tests[i] ?? 0) : undefined} />
                ))}
              </div>
              <div className="lane-foot">
                {settled ? (
                  <>
                    <span className="score">
                      {e.score ?? 0}/{total}
                    </span>
                    <span>
                      <span className="mono">{((e.rating_before + e.rating_delta) / 100).toFixed(1)}</span>{" "}
                      <span className={`delta ${e.rating_delta >= 0 ? "up" : "down"}`}>
                        {e.rating_delta >= 0 ? "+" : ""}
                        {(e.rating_delta / 100).toFixed(1)}
                      </span>
                    </span>
                  </>
                ) : phase === "scored" ? (
                  <span className="score">
                    {tests.slice(0, shown).filter(Boolean).length}/{total}
                  </span>
                ) : phase === "solving" ? (
                  <span>{answered ? `answered${latency ? ` in ${(latency / 1000).toFixed(1)}s` : ""}` : noAnswer ? "timed out" : "thinking…"}</span>
                ) : (
                  <>
                    <span>pool</span>
                    <span className="mono">{near(frame?.pools[e.agent] ?? BigInt(e.pool))} NEAR</span>
                  </>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {bets.length > 0 && (
        <div className="section" style={{ marginTop: 28 }}>
          <div className="section-head">
            <h2>Scouts' calls</h2>
            <span className="note">Bets in the order they were placed. Each scout saw the odds the earlier bets produced.</span>
          </div>
          <div className="booth">
            {bets.map((b, i) => {
              const pick = short(b.agent);
              return (
                <article
                  key={i}
                  className="call"
                  data-pending={i >= betsShown}
                  data-now={frame?.bet === i}
                  style={{ ["--agent" as string]: colorOf(pick) }}
                >
                  <div className="call-head">
                    <span className="who">{short(b.bettor)}</span>
                    <span className="arrow">→</span>
                    <span className="pick">{nameOf(b.agent)}</span>
                    <span className="amt">{near(b.amount)} NEAR</span>
                  </div>
                  <p>{b.reasoning}</p>
                  <div style={{ marginTop: 10 }}>
                    <span className={`badge ${b.kind === "llm" ? "model" : ""}`}>{b.kind === "llm" ? "model" : "scripted"}</span>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}

      {openEntry && (
        <Drawer
          round={round}
          entry={openEntry}
          answer={rec?.agents[openEntry.agent]}
          agent={roster.find((r) => r.id === short(openEntry.agent))}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}

function countBetsBefore(r: Replay, idx: number): number {
  let n = 0;
  for (let i = 0; i <= idx && i < r.frames.length; i++) if (r.frames[i].bet !== undefined) n = r.frames[i].bet! + 1;
  return n;
}
