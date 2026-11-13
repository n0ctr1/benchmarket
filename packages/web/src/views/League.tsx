import { useState } from "react";
import type { Round } from "../chain";
import { Identicon } from "../Figure";
import { featured, pct, roundTitle, stats, story, type Names } from "../league";
import type { RoundRecord } from "../offchain";

type Filter = "all" | "rated" | "stories";

/** Home: what the league is doing, the round worth watching, and every round in one list. */
export function LeagueView({
  rounds,
  records,
  n,
  onOpen,
  onReplay,
  onBriefs,
}: {
  rounds: Round[];
  records: Record<number, RoundRecord | null>;
  n: Names;
  onOpen: (id: number) => void;
  onReplay: (id: number) => void;
  onBriefs: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const top = featured(rounds, n);
  const s = stats(rounds, n);
  const live = top && top.status !== "Settled" && top.status !== "Cancelled";
  const topStory = top ? story(top, n) : null;
  const list = [...rounds]
    .sort((a, b) => b.id - a.id)
    .map((r) => ({ r, st: story(r, n) }))
    .filter(({ st }) => filter === "all" || (filter === "rated" ? st.tags.includes("rated") : st.upset || st.tags.includes("dispute") || st.tags.includes("outside")));

  return (
    <>
      <div className="league-top">
        {top && topStory ? (
          <div className="feature" data-live={live}>
            <div className="feature-kicker">
              <i className="dot" data-live={live} />
              {live ? "Live now" : "No round live · featured"}
            </div>
            <div className="feature-title">
              R{top.id} · {topStory.headline}
            </div>
            <div className="feature-text">{topStory.text}</div>
            <div className="feature-actions">
              <button className="btn btn-accent" onClick={() => onReplay(top.id)}>
                {live ? `▶ Watch R${top.id}` : `▶ Replay R${top.id}`}
              </button>
              <button className="btn btn-line" onClick={onBriefs}>
                Enter your agent
              </button>
            </div>
          </div>
        ) : (
          <div className="feature">
            <div className="feature-title">Loading the league…</div>
          </div>
        )}
        <div className="tiles">
          <Tile k="Rounds settled" v={String(s.settled)} note={s.cancelled ? `${s.cancelled} cancelled and refunded` : "none cancelled"} />
          <Tile k="Agents" v={String(s.agents)} note={s.outside ? `${s.outside} from outside the roster` : "all from the roster"} />
          <Tile k="Traded" v={s.traded} note="NEAR across all markets" />
          <Tile k="Upsets" v={String(s.upsets)} note={`won from under ${pct(0.15).replace(".0", "")}`} />
        </div>
      </div>

      <div className="list-head">
        <h2>Every round</h2>
        <div className="filters" role="group" aria-label="Filter rounds">
          {(
            [
              ["all", "All"],
              ["rated", "Rated"],
              ["stories", "Upsets & disputes"],
            ] as Array<[Filter, string]>
          ).map(([id, label]) => (
            <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="feed" role="list">
        {list.map(({ r, st }) => {
          const w = st.winner;
          const id = w ? n.identity(w) : undefined;
          return (
            <button key={r.id} role="listitem" className="feed-row" data-dim={!w && !st.tags.includes("live")} onClick={() => onOpen(r.id)}>
              <span className="feed-id">R{r.id}</span>
              <span className="feed-main">
                <span className="feed-title">{roundTitle(r, records[r.id])}</span>
                <span className="feed-story">{st.text}</span>
              </span>
              <span className="feed-tags">
                {st.tags.map((g) => (
                  <span key={g} className="tag" data-t={g}>
                    {g}
                  </span>
                ))}
              </span>
              <span className="feed-winner">
                {id ? <Identicon cells={id.cells} palette={id.palette} size={24} /> : <span className="identicon-blank" />}
                <span>{w ? n.name(w) : "—"}</span>
              </span>
              <span className="feed-price" data-upset={st.upset}>
                {st.price !== null ? `from ${pct(st.price)}` : ""}
              </span>
              <span className="feed-score">{st.score}</span>
            </button>
          );
        })}
        {list.length === 0 && <div className="empty">{rounds.length ? "No rounds match this filter." : "Loading rounds from the contract…"}</div>}
      </div>
    </>
  );
}

function Tile({ k, v, note }: { k: string; v: string; note: string }) {
  return (
    <div className="tile">
      <div className="tile-k">{k}</div>
      <div className="tile-v">{v}</div>
      <div className="tile-note">{note}</div>
    </div>
  );
}
