import type { Face } from "@agent-league/shared/identity";
import { HUES } from "@agent-league/shared/identity";
import type { Identity, Rating } from "./chain";
import { short } from "./chain";
import { FaceArt } from "./Figure";
import { hueColor, mrz } from "./identity";
import type { IdentityNotes, RosterAgent } from "./offchain";

export interface LiveLine {
  odds?: number;
  p?: number;
  score?: string;
  delta?: number;
  state?: string;
}

/** The agent's passport: its own face, motto and public record. */
export function Passport({
  agent,
  identity,
  roster,
  rating,
  notes,
  live,
  active,
  onHover,
  onOpen,
}: {
  agent: string;
  identity?: Identity;
  roster?: RosterAgent;
  rating?: Rating;
  notes?: IdentityNotes;
  live?: LiveLine;
  active?: boolean;
  onHover?: (a: string | null) => void;
  onOpen?: () => void;
}) {
  const name = roster?.name ?? short(agent);
  const rejected = notes?.attempts.filter((a) => a.rejected).length ?? 0;
  return (
    <button
      className="passport"
      data-active={active}
      style={{ ["--agent" as string]: hueColor(identity) }}
      onMouseEnter={() => onHover?.(agent)}
      onMouseLeave={() => onHover?.(null)}
      onFocus={() => onHover?.(agent)}
      onBlur={() => onHover?.(null)}
      onClick={onOpen}
      aria-label={`${name} passport`}
    >
      <div className="pp-head">
        <span>Agent passport</span>
        <span className="mono">No. {identity ? String(identity.number).padStart(3, "0") : "—"}</span>
      </div>
      <div className="pp-body">
        {identity ? <FaceArt face={identity.face as Face} className="pp-face" /> : <div className="pp-face pp-missing">no passport</div>}
        <div className="pp-fields">
          <div className="pp-name">{name}</div>
          <div className="pp-model">{roster?.model ?? agent}</div>
          {identity && <div className="pp-motto">"{identity.motto}"</div>}
        </div>
      </div>
      <dl className="pp-grid">
        <div>
          <dt>Rating</dt>
          <dd>{rating ? (rating.rating / 100).toFixed(1) : "1500.0"}</dd>
        </div>
        <div>
          <dt>W / R</dt>
          <dd>
            {rating?.wins ?? 0} / {rating?.rounds ?? 0}
          </dd>
        </div>
        <div>
          <dt>Color</dt>
          <dd>{identity ? HUES[identity.face[6]]?.name : "—"}</dd>
        </div>
        <div>
          <dt>Tries</dt>
          <dd title={rejected ? `${rejected} face(s) rejected as too close to another agent` : "accepted on the first try"}>
            {notes ? notes.attempts.length : "—"}
          </dd>
        </div>
      </dl>
      {live && (
        <div className="pp-live">
          {live.state && <span>{live.state}</span>}
          {live.odds !== undefined && <span className="mono">{(live.odds * 100).toFixed(1)}%</span>}
          {live.score && <span className="mono">{live.score}</span>}
          {live.delta !== undefined && (
            <span className={`mono delta ${live.delta >= 0 ? "up" : "down"}`}>
              {live.delta >= 0 ? "+" : ""}
              {live.delta.toFixed(1)}
            </span>
          )}
        </div>
      )}
      {identity && <div className="pp-mrz mono">{mrz(name, identity)}</div>}
    </button>
  );
}
