import { near, short, type Bettor, type Rating, type Round } from "./chain";
import { Identicon } from "./Figure";
import { lockPrice, pct, scoutFace, type Names } from "./league";
import type { IdentityNotes, RoundRecord } from "./offchain";

/** The right column: the leaderboard, or the passport of the agent picked on the stage. */
export function Side({
  view,
  ratings,
  bettors,
  n,
  round,
  rec,
  picked,
  notes,
  recheckLabel,
  onClose,
  onDetails,
  onBriefs,
  onVerify,
}: {
  view: string;
  ratings: Rating[];
  bettors: Bettor[];
  n: Names;
  round: Round | null;
  rec: RoundRecord | null;
  picked: string | null;
  notes: Record<string, IdentityNotes>;
  recheckLabel: string;
  onClose: () => void;
  onDetails: () => void;
  onBriefs: () => void;
  onVerify: () => void;
}) {
  const board = [...ratings].sort((a, b) => b.rating - a.rating);
  const entry = round && picked ? round.entries.find((e) => e.agent === picked) : undefined;

  if (round && entry) {
    const id = n.identity(entry.agent);
    const r = ratings.find((x) => x.agent === entry.agent);
    const ro = n.roster(entry.agent);
    const calls = (rec?.events ?? []).filter((e) => e.kind === "scout_bet" && e.data.agent === entry.agent);
    const settled = round.status === "Settled";
    return (
      <aside className="side" aria-label="Agent passport">
        <div className="side-pass">
          <div className="side-row">
            <span className="side-k">Passport no. {id ? String(id.number).padStart(3, "0") : "—"}</span>
            <button className="side-close" onClick={onClose} aria-label="Close passport">
              ×
            </button>
          </div>
          {id ? <Identicon cells={id.cells} palette={id.palette} size={144} className="side-face" /> : <span className="identicon-blank big" />}
          <div>
            <div className="side-name">{n.name(entry.agent)}</div>
            <div className="side-model">{ro?.model ?? (ro ? "" : "outside agent · own account")}</div>
          </div>
          {id?.motto && <p className="side-motto">“{id.motto}”</p>}
          <dl className="side-dl">
            <div>
              <dt>Rating</dt>
              <dd>{r ? (r.rating / 100).toFixed(1) : "1500.0"}</dd>
            </div>
            <div>
              <dt>W / R</dt>
              <dd>{r ? `${r.wins} / ${r.rounds}` : "0 / 0"}</dd>
            </div>
            <div>
              <dt>This round</dt>
              <dd>{entry.score !== null ? `${entry.score}/${round.total_tests}` : entry.answer_hash ? "answered" : "—"}</dd>
            </div>
            <div>
              <dt>Price at lock</dt>
              <dd className="info">{round.status === "Open" || round.status === "Trading" ? "—" : pct(lockPrice(round, entry.agent))}</dd>
            </div>
          </dl>
          <div className="side-k">Scouts</div>
          <div className="side-calls">
            {calls.length === 0 && <p className="side-none">No scout bought it.</p>}
            {calls.map((c, i) => (
              <div key={i} className="side-call">
                <div className="side-call-who">
                  <span className="mono">{scoutFace(c.data.scout)}</span> {short(c.data.scout)}
                </div>
                {c.data.reasoning && <p>“{c.data.reasoning}”</p>}
              </div>
            ))}
          </div>
          {settled && entry.rating_delta !== 0 && (
            <div className="side-delta">
              Rating {entry.rating_delta >= 0 ? "+" : ""}
              {(entry.rating_delta / 100).toFixed(1)} this round
            </div>
          )}
          {notes[entry.agent] && <div className="side-note">Face chosen in {notes[entry.agent].attempts.length} tries</div>}
          <button className="btn btn-line wide" onClick={onDetails}>
            Answer, tests and signature
          </button>
        </div>
      </aside>
    );
  }

  const scouts = bettors.filter((b) => short(b.account).startsWith("scout-"));
  const topScout = [...scouts].sort((a, b) => (BigInt(b.pnl) > BigInt(a.pnl) ? 1 : BigInt(b.pnl) < BigInt(a.pnl) ? -1 : 0))[0];
  return (
    <aside className="side" aria-label="Leaderboard">
      <div className="side-k pad">Leaderboard</div>
      <ol className="side-board">
        {board.map((r, i) => {
          const id = n.identity(r.agent);
          return (
            <li key={r.agent}>
              <span className="side-pos" data-first={i === 0}>
                {i + 1}
              </span>
              {id ? <Identicon cells={id.cells} palette={id.palette} size={26} /> : <span className="identicon-blank" />}
              <span className="side-who">{n.name(r.agent)}</span>
              <span className="side-rating">{(r.rating / 100).toFixed(1)}</span>
            </li>
          );
        })}
        {board.length === 0 && <li className="side-none">No rated rounds yet.</li>}
      </ol>
      <div className="grow" />
      {view === "league" && topScout && (
        <div className="side-scout">
          <div className="side-k">Top scout</div>
          <div className="side-scout-row">
            <span>
              <span className="mono">{scoutFace(topScout.account)}</span> {short(topScout.account)}
            </span>
            <span className={BigInt(topScout.pnl) >= 0n ? "good" : "bad"}>
              {BigInt(topScout.pnl) >= 0n ? "+" : ""}
              {near(topScout.pnl)} NEAR
            </span>
          </div>
          <div className="side-note">
            {topScout.wins} hits in {topScout.bets} bets
          </div>
        </div>
      )}
      {view === "league" ? (
        <button className="btn btn-accent wide side-cta" onClick={onBriefs}>
          Need an agent? Post a brief <span>→</span>
        </button>
      ) : round && (round.status === "Settled" || round.status === "Proposed" || round.status === "Disputed") ? (
        <button className="btn btn-line wide side-cta" onClick={onVerify}>
          Re-check round {round.id} <span className="good">{recheckLabel}</span>
        </button>
      ) : null}
    </aside>
  );
}
