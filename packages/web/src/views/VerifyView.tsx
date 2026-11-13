import { useEffect, useState } from "react";
import { view, type Round } from "../chain";
import { recheckRound, type ChainConfig, type Check, type Published } from "../verify/recheck";

export type RecheckState = "idle" | "loading" | "running" | "done" | "error";

export interface Recheck {
  round: number | null;
  checks: Check[];
  state: RecheckState;
  error: string | null;
}

/** Re-checks a round in this browser: report, hashes, signatures, every answer re-run. */
export function useRecheck(round: Round | null, run: boolean): Recheck {
  const [res, setRes] = useState<Recheck>({ round: null, checks: [], state: "idle", error: null });
  useEffect(() => {
    if (!round || !run) return;
    if (res.round === round.id && res.state !== "idle") return;
    let live = true;
    setRes({ round: round.id, checks: [], state: "loading", error: null });
    (async () => {
      try {
        const r = await fetch(`./data/reports/${round.id}.json`);
        if (!r.ok) throw new Error("This round has no published report yet.");
        const pub = (await r.json()) as Published;
        const config = await view<ChainConfig>("get_config");
        if (!live) return;
        setRes((x) => ({ ...x, state: "running" }));
        await recheckRound(round, pub, config, (c) => live && setRes((x) => ({ ...x, checks: [...x.checks, c] })));
        if (live) setRes((x) => ({ ...x, state: "done" }));
      } catch (e) {
        if (live) setRes((x) => ({ ...x, state: "error", error: e instanceof Error ? e.message : String(e) }));
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round?.id, run]);
  return res.round === round?.id ? res : { round: round?.id ?? null, checks: [], state: "idle", error: null };
}

export const recheckSummary = (r: Recheck) => {
  const failed = r.checks.filter((c) => !c.ok).length;
  return { failed, passed: r.checks.length - failed, total: r.checks.length };
};

export function VerifyView({ round, recheck, verifiable, onBack }: { round: Round | null; recheck: Recheck; verifiable: boolean; onBack: () => void }) {
  const { failed, total } = recheckSummary(recheck);
  const groups = [...new Set(recheck.checks.map((c) => c.group))];
  return (
    <>
      <div className="round-top">
        <button className="back-link" onClick={onBack}>
          ← Round {round?.id ?? ""}
        </button>
      </div>
      <div className="page-head">
        <h1>Re-check round {round?.id ?? ""}</h1>
        <span className="verify-count" data-state={recheck.state} data-failed={failed > 0}>
          {recheck.state === "done" ? `${total - failed} / ${total}` : recheck.state === "running" || recheck.state === "loading" ? `${total}…` : ""}
        </span>
      </div>
      <p className="page-note">
        Run in this browser from the contract and the verifier's published report. Answers re-run in a worker with no network. Nothing here asks to be trusted.
      </p>
      {!verifiable && <div className="empty">Pick a round that has been scored: its report is what gets re-checked.</div>}
      {recheck.state === "error" && <div className="empty">{recheck.error}</div>}
      <div className="page-scroll checks">
        {groups.map((g) => (
          <section key={g} className="check-group">
            <h2 className="sub">{g}</h2>
            <div className="check-grid">
              {recheck.checks
                .filter((c) => c.group === g)
                .map((c, i) => (
                  <div key={i} className="check" data-ok={c.ok}>
                    <span className="check-mark">{c.ok ? "✓" : "✗"}</span>
                    <span>
                      <span className="check-label">{c.label}</span>
                      <span className="check-detail">{c.detail}</span>
                    </span>
                  </div>
                ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
