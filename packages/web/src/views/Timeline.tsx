import { useEffect } from "react";
import { short, type Round } from "../chain";
import { scoutFace, type Names } from "../league";
import type { LogEvent, RoundRecord } from "../offchain";

/** Elapsed time from the round's creation, as m:ss.s. */
function stamp(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

const KIND: Record<string, string> = {
  round_created: "Round created",
  scout_bet: "Scout bet",
  answer_submitted: "Answer committed",
  answer_failed: "Answer failed",
  scores_proposed: "Scores posted",
  watcher_check: "Watcher re-check",
  disputed: "Disputed",
  dispute_resolved: "Dispute resolved",
  round_settled: "Settled",
};

function detail(e: LogEvent, n: Names): string {
  const d = e.data ?? {};
  switch (e.kind) {
    case "round_created":
      return `${d.task?.title ?? d.task?.id ?? ""}: ${d.task?.function ?? ""}()`;
    case "scout_bet":
      return `${scoutFace(d.scout)} ${short(d.scout)} buys ${n.name(d.agent)}${d.price_before !== undefined ? ` at ${(Number(d.price_before) * 100).toFixed(1)}%` : ""}${d.price_after_ppm ? ` to ${(Number(d.price_after_ppm) / 1e4).toFixed(1)}%` : ""}${d.model ? ` (${d.model})` : ""}: “${d.reasoning ?? ""}”`;
    case "answer_submitted":
      return `${n.name(d.agent)} · ${d.answer_hash?.slice(0, 22) ?? ""}…${d.meta?.model ? ` · ${d.meta.model}` : ""}${d.meta?.latencyMs ? ` · ${(d.meta.latencyMs / 1000).toFixed(1)}s` : ""}${d.attested ? " · attested" : ""}`;
    case "answer_failed":
      return `${n.name(d.agent)}: ${String(d.error ?? "").slice(0, 120)}`;
    case "scores_proposed":
      return (d.scores ?? []).map((x: [string, number]) => `${n.name(x[0])} ${x[1]}`).join(", ");
    case "watcher_check":
      return d.ok === false ? `mismatch: ${(d.problems ?? []).join("; ").slice(0, 160)}` : "every published answer re-run gives the posted score";
    case "disputed":
      return `by ${short(d.by ?? "")}${d.bond ? ` with a ${(Number(BigInt(d.bond)) / 1e24).toFixed(2)} NEAR bond` : ""}`;
    case "dispute_resolved":
      return d.overturned ? "arbiters overturned the posted scores; the verifier's stake is slashed" : "arbiters upheld the posted scores";
    case "round_settled":
      return (d.winners ?? (d.winner ? [d.winner] : [])).length ? `winner ${(d.winners ?? [d.winner]).map((w: string) => n.name(w)).join(", ")}` : "settled with no winner";
    default:
      return JSON.stringify(d).slice(0, 160);
  }
}

/** Every logged event of the round with its timing; a row jumps the replay to that moment. */
export function Timeline({ round, rec, n, onSeek, onClose }: { round: Round; rec: RoundRecord | null; n: Names; onSeek: (e: LogEvent, i: number) => void; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const events = rec?.events ?? [];
  const t0 = events[0]?.at ?? round.created_at_ms;
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer timeline" role="dialog" aria-label={`Round ${round.id} timeline`}>
        <button className="close mono" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div className="muted mono" style={{ fontSize: 12 }}>
          ROUND {round.id} · {round.task_ref}
        </div>
        <h3>Everything that happened</h3>
        <p className="muted" style={{ fontSize: 13 }}>
          From the orchestrator's round log and the contract. Times are from the round's creation. Click a row to jump the replay there.
        </p>
        {events.length === 0 && <p className="muted">No published log for this round.</p>}
        <ol className="tl">
          {events.map((e, i) => (
            <li key={i} data-kind={e.kind}>
              <button onClick={() => onSeek(e, i)}>
                <span className="tl-t">{stamp(e.at - t0)}</span>
                <span className="tl-k">{KIND[e.kind] ?? e.kind.replace(/_/g, " ")}</span>
                <span className="tl-d">{detail(e, n)}</span>
              </button>
            </li>
          ))}
        </ol>
        {round.proposal && (
          <p className="muted" style={{ fontSize: 12 }}>
            Scores posted with {round.proposal.signers.length} verifier signatures; dispute window until {new Date(round.proposal.dispute_until_ms).toISOString().slice(11, 19)} UTC.
          </p>
        )}
      </aside>
    </>
  );
}
