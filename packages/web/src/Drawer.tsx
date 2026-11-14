import { useEffect } from "react";
import { deriveFace, faceCode } from "@benchmarket/shared/identity";
import { near, EXPLORER, short, type Entry, type Identity, type Round } from "./chain";
import { Figure, Identicon } from "./Figure";
import { hueColor, mrz } from "./identity";
import type { AgentAnswer, IdentityNotes, RosterAgent } from "./offchain";

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
  identity,
  notes,
  onClose,
}: {
  round: Round;
  entry: Entry;
  answer?: AgentAnswer;
  agent?: RosterAgent;
  identity?: Identity;
  notes?: IdentityNotes;
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
  const won = round.winners.includes(entry.agent);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={`${agent?.name ?? id} in round ${round.id}`} style={{ ["--agent" as string]: hueColor(identity) }}>
        <button className="close mono" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
          {identity && <Figure cells={identity.cells} palette={identity.palette} pose={entry.answer_hash ? "idle" : "out"} still />}
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
            {((entry.rating_before) / 100).toFixed(1)} to {((entry.rating_before + entry.rating_delta) / 100).toFixed(1)}
            {round.market === "lmsr" && round.rated && round.status === "Settled" && (
              <span className="muted">
                {" "}
                (field {fmt(entry.field_delta)}, task {fmt(entry.task_delta)})
              </span>
            )}
          </dd>
          {round.market === "lmsr" && (
            <>
              <dt>Attestation</dt>
              <dd>
                {entry.attested
                  ? `verified on chain: NEAR AI signed this exact response${entry.model ? ` from ${entry.model}` : ""}`
                  : entry.answer_hash
                    ? "none (plain answer hash)"
                    : "no answer"}
              </dd>
              <dt>Bond</dt>
              <dd>{near(entry.bond)} NEAR{entry.answer_hash ? " (returned)" : round.status === "Settled" ? " (forfeited)" : ""}</dd>
            </>
          )}
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

        {identity && (
          <>
            <h4>Passport</h4>
            <div className="pp-detail">
              <dl className="kv" style={{ margin: 0 }}>
                <dt>Number</dt>
                <dd>{String(identity.number).padStart(3, "0")}</dd>
                <dt>Face</dt>
                <dd>
                  {identity.face_code} · palette {identity.palette.map((h) => `${h}°`).join(" ")}
                </dd>
                <dt>Motto</dt>
                <dd>"{identity.motto}"</dd>
                <dt>Seed</dt>
                <dd className="plain">{identity.seed}</dd>
                <dt>Issued</dt>
                <dd>
                  {new Date(identity.issued_at_ms).toISOString().slice(0, 16).replace("T", " ")} UTC by {identity.issuer}
                </dd>
                <dt>Proof</dt>
                <dd>{identity.proof}</dd>
                {notes?.zeroPromptHash && (
                  <>
                    <dt>Zero prompt</dt>
                    <dd>{notes.zeroPromptHash}</dd>
                  </>
                )}
              </dl>
              <div className="pp-mrz mono">{mrz(agent?.name ?? id, identity)}</div>
            </div>
            {notes && notes.attempts.length > 0 && (
              <>
                <h4>How the face was made</h4>
                <div className="attempts">
                  {notes.attempts.map((attempt, i) => {
                    // The face is a function of the seed; re-derive it instead of trusting the record.
                    const a = { ...attempt, face: attempt.seed ? deriveFace(attempt.seed) : null };
                    return (
                    <div key={i} className="attempt" data-ok={!a.rejected}>
                      {a.face ? (
                        <Identicon cells={a.face.cells} palette={a.face.palette} size={36} />
                      ) : (
                        <span className="identicon-empty" />
                      )}
                      <div>
                        <div className="mono" style={{ fontSize: 12 }}>
                          try {i + 1} · {a.face ? faceCode(a.face) : "invalid reply"}
                        </div>
                        {a.seed && <div style={{ fontSize: 12.5, margin: "2px 0" }}>{a.seed}</div>}
                        <div className="muted" style={{ fontSize: 12 }}>
                          {a.rejected ?? "accepted by the contract"}
                        </div>
                      </div>
                    </div>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}

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

function fmt(centi: number): string {
  return `${centi >= 0 ? "+" : ""}${(centi / 100).toFixed(1)}`;
}
