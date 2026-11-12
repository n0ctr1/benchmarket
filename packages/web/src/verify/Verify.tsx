import { useEffect, useRef, useState } from "react";
import { view, type Round } from "../chain";
import { recheckRound, type ChainConfig, type Check, type Published } from "./recheck";

/** A panel that re-checks one round in the viewer's browser and lists every check with its values. */
export function Verify({ round, onClose }: { round: Round; onClose: () => void }) {
  const [checks, setChecks] = useState<Check[]>([]);
  const [state, setState] = useState<"loading" | "running" | "done" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        const res = await fetch(`./data/reports/${round.id}.json`);
        if (!res.ok) throw new Error("this round has no published report yet");
        const pub = (await res.json()) as Published;
        const config = await view<ChainConfig>("get_config");
        setState("running");
        await recheckRound(round, pub, config, (c) => setChecks((xs) => [...xs, c]));
        setState("done");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setState("error");
      }
    })();
  }, [round]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const failed = checks.filter((c) => !c.ok).length;
  const groups = [...new Set(checks.map((c) => c.group))];
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer verify" role="dialog" aria-label={`Re-check round ${round.id}`}>
        <button className="close mono" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div className="muted mono" style={{ fontSize: 12 }}>
          ROUND {round.id} · {round.task_ref}
        </div>
        <h3>Re-checked in your browser</h3>
        <p className="muted" style={{ fontSize: 13 }}>
          Read from the contract over RPC and from the verifier's published report. Answers re-run here in an isolated worker with no network. Nothing on this
          panel asks to be trusted.
        </p>
        <div className="verify-summary" data-state={state} data-failed={failed > 0}>
          {state === "loading" && "Loading the report…"}
          {state === "running" && `${checks.length} checks so far…`}
          {state === "done" && (failed === 0 ? `${checks.length} checks passed` : `${failed} of ${checks.length} checks failed`)}
          {state === "error" && error}
        </div>
        {groups.map((g) => (
          <section key={g} className="verify-group">
            <h4>{g}</h4>
            <ul>
              {checks
                .filter((c) => c.group === g)
                .map((c, i) => (
                  <li key={i} data-ok={c.ok}>
                    <span className="mark mono">{c.ok ? "✓" : "✗"}</span>
                    <div>
                      <div>{c.label}</div>
                      <div className="mono muted detail">{c.detail}</div>
                    </div>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </aside>
    </>
  );
}
