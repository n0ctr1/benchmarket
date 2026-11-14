import { near, short, type Bettor, type Rating, type Round } from "./chain";
import { Identicon } from "./Figure";
import { lockPrice, pct, scoutFace, type Names } from "./league";
import type { IdentityNotes, RoundRecord } from "./offchain";
import { Profile, type ProfileRef } from "./Profile";

type ProfileData = Parameters<typeof Profile>[0]["data"];

/** The right column: the leaderboard, or the passport of the agent picked on the stage. */
export function Side({
  open,
  ratings,
  bettors,
  n,
  round,
  rec,
  picked,
  notes,
  onClose,
  onDetails,
  onPost,
  profile,
  profileData,
  onRound,
  onProfile,
}: {
  open: boolean;
  ratings: Rating[];
  bettors: Bettor[];
  n: Names;
  round: Round | null;
  rec: RoundRecord | null;
  picked: string | null;
  notes: Record<string, IdentityNotes>;
  onClose: () => void;
  onDetails: () => void;
  onPost: () => void;
  profile: ProfileRef | null;
  profileData: ProfileData;
  onRound: (id: number) => void;
  onProfile: (p: ProfileRef | null) => void;
}) {
  const board = [...ratings].sort((a, b) => b.rating - a.rating);
  // One profile everywhere: from the leaderboard, or from the stage with this round on top.
  const entry = round && picked ? round.entries.find((e) => e.agent === picked) : undefined;
  const refd: ProfileRef | null = entry ? { kind: "agent", id: entry.agent } : profile;
  if (refd) {
    return (
      <aside className="side" data-open={open} aria-label="Profile">
        <Profile
          refd={refd}
          data={profileData}
          onClose={() => (entry ? onClose() : onProfile(null))}
          onRound={onRound}
          onProfile={onProfile}
          here={entry && round && refd.kind === "agent" && refd.id === entry.agent ? { round, rec, onDetails } : undefined}
        />
      </aside>
    );
  }

  const scouts = bettors.filter((b) => short(b.account).startsWith("scout-"));
  const topScout = [...scouts].sort((a, b) => (BigInt(b.pnl) > BigInt(a.pnl) ? 1 : BigInt(b.pnl) < BigInt(a.pnl) ? -1 : 0))[0];
  return (
    <aside className="side" data-open={open} aria-label="Leaderboard" aria-hidden={!open}>
      <div className="side-row pad">
        <span className="side-title">Top agents</span>
        <button className="side-close" onClick={onClose} aria-label="Close leaderboard">
          ×
        </button>
      </div>
      <ol className="side-board">
        {board.map((r, i) => {
          const id = n.identity(r.agent);
          return (
            <li key={r.agent} onClick={() => onProfile({ kind: "agent", id: r.agent })} role="button" tabIndex={0}>
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
      {topScout && (
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
      <div className="side-cta">
        <button className="btn btn-accent wide" onClick={onPost}>
          Need an agent? Post a task
        </button>
      </div>
    </aside>
  );
}
