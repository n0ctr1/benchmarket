import { useEffect } from "react";
import { EXPLORER, short, type Entry, type Round } from "./chain";
import type { AgentAnswer, RosterAgent } from "./offchain";
import { Robot } from "./Robot";
import { colorOf } from "./robots";

export function signatureLabel(a: AgentAnswer | undefined): string {
  if (!a?.meta) return "";
  if (a.meta.mode === "sim") return "sim";
  const k = a.meta.signature?.signature_kind;
  if (k === "provider_tee") return "TEE signed";
  if (k === "gateway") return "gateway signed";
  return a.meta.signature ? "signed" : "unsigned";
}

export function Drawer({
  round,
  entry,
  answer,
  agent,
  onClose,
}: {
  round: Round;
  entry: Entry;
  answer?: AgentAnswer;
  agent?: RosterAgent;
  onClose: () => void;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const id = short(entry.agent);
  const meta = answer?.meta;
  const sig = meta?.signature;
  const won = round.winner === entry.agent;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={`${agent?.name ?? id} in round ${round.id}`} style={{ ["--agent" as string]: colorOf(id) }}>
        <button className="close mono" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
          <Robot id={id} mood={won ? "win" : entry.answer_hash ? "idle" : "out"} />
          <div>
            <div className="muted mono" style={{ fontSize: 12 }}>
              ROUND {round.id} · {round.task_ref}
            </div>
            <h3>{agent?.name ?? id}</h3>
            <div className="mono muted" style={{ fontSize: 12 }}>
              {agent?.model}
            </div>
          </div>
        </div>

        <dl className="kv">
          <dt>Account</dt>
          <dd>
            <a href={`${EXPLORER}/address/${entry.agent}`} target="_blank" rel="noreferrer">
              {entry.agent}
            </a>
          </dd>
          <dt>Score</dt>
          <dd>{entry.score === null ? "not scored" : `${entry.score} / ${round.total_tests}`}</dd>
          <dt>Expected (p)</dt>
          <dd>{(entry.p_ppm / 1e4).toFixed(1)}%</dd>
          <dt>Rating change</dt>
          <dd>
            {((entry.rating_before) / 100).toFixed(1)} → {((entry.rating_before + entry.rating_delta) / 100).toFixed(1)}
          </dd>
          <dt>Config hash</dt>
          <dd>{entry.config_hash}</dd>
          <dt>Answer hash</dt>
          <dd>{entry.answer_hash ?? "no answer"}</dd>
          {meta?.mode === "llm" && (
            <>
              <dt>Completion</dt>
              <dd>
                {meta.completionId} · {meta.usage?.completion_tokens ?? "?"} tokens · {((meta.latencyMs ?? 0) / 1000).toFixed(1)}s
              </dd>
              <dt>Signature</dt>
              <dd>{sig ? `${signatureLabel(answer)} · ${sig.signing_algo} · ${sig.signature.slice(0, 32)}…` : "none"}</dd>
              {sig && (
                <>
                  <dt>Signed text</dt>
                  <dd>{sig.text}</dd>
                  <dt>Signer</dt>
                  <dd>{sig.signing_address}</dd>
                </>
              )}
            </>
          )}
          {meta?.mode === "sim" && (
            <>
              <dt>Mode</dt>
              <dd>simulation (scripted answer, real tests)</dd>
            </>
          )}
        </dl>

        {answer?.compileError && (
          <>
            <h4>Compile error</h4>
            <pre className="code">{answer.compileError}</pre>
          </>
        )}
        {answer && (
          <>
            <h4>Submitted answer</h4>
            <pre className="code">{answer.code}</pre>
          </>
        )}
        {!answer && <p className="muted">The answer is published once the round is scored.</p>}
        {agent && (
          <>
            <h4>System prompt</h4>
            <pre className="code prompt">{agent.systemPrompt}</pre>
            {agent.strengths.length > 0 && (
              <p className="muted" style={{ fontSize: 13 }}>
                Claimed strengths: {agent.strengths.join(", ")}
              </p>
            )}
          </>
        )}
      </aside>
    </>
  );
}
