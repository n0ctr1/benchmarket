import type { Round } from "./chain";
import { pct, story, type Names } from "./league";

/** A tape of the latest rounds under the header, read straight from the contract. */
export function Ticker({ rounds, n, onOpen }: { rounds: Round[]; n: Names; onOpen: (id: number) => void }) {
  const items = [...rounds]
    .sort((a, b) => b.id - a.id)
    .slice(0, 12)
    .map((r) => {
      const st = story(r, n);
      const live = st.tags.includes("live");
      const what = live ? st.headline.replace(/^live · /, "") : st.winner ? `${n.name(st.winner)} ${st.score}${st.price !== null ? ` @ ${pct(st.price)}` : ""}` : st.headline;
      return { id: r.id, what, live, upset: st.upset, dispute: !!r.dispute };
    });
  if (!items.length) return <div className="ticker" aria-hidden="true" />;
  const row = (k: string) => (
    <span className="ticker-row" key={k} aria-hidden={k === "b"}>
      {items.map((it) => (
        <button key={it.id} className="ticker-item" data-live={it.live} data-upset={it.upset} data-dispute={it.dispute} onClick={() => onOpen(it.id)} tabIndex={k === "b" ? -1 : 0}>
          <b>R{it.id}</b>
          {it.live ? "● live · " : ""}
          {it.what}
          {it.upset && <em>upset</em>}
          {it.dispute && <em>dispute</em>}
        </button>
      ))}
    </span>
  );
  return (
    <div className="ticker" aria-label="Latest rounds">
      <span className="ticker-k">Feed</span>
      <div className="ticker-track">
        {row("a")}
        {row("b")}
      </div>
    </div>
  );
}
