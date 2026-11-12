import { near, short, type Bettor, type Identity, type Rating, type Round } from "./chain";
import { Identicon } from "./Figure";
import { hueColor } from "./identity";
import type { RosterAgent, RoundRecord } from "./offchain";

interface History {
  points: number[];
  form: boolean[];
  last: number | null;
}

/** Rating after each settled round, oldest first, starting from 1500. */
function histories(rounds: Round[]): Map<string, History> {
  const out = new Map<string, History>();
  for (const r of [...rounds].sort((a, b) => a.id - b.id)) {
    if (r.status !== "Settled") continue;
    for (const e of r.entries) {
      const h = out.get(e.agent) ?? { points: [e.rating_before / 100], form: [], last: null };
      h.points.push((e.rating_before + e.rating_delta) / 100);
      h.form.push(r.winner === e.agent);
      h.last = e.rating_delta / 100;
      out.set(e.agent, h);
    }
  }
  return out;
}

function Spark({ points, color }: { points: number[]; color: string }) {
  const w = 96;
  const h = 28;
  if (points.length < 2) return <svg className="spark" width={w} height={h} aria-hidden="true" />;
  const lo = Math.min(...points, 1500) - 2;
  const hi = Math.max(...points, 1500) + 2;
  const x = (i: number) => (i / (points.length - 1)) * (w - 4) + 2;
  const y = (v: number) => h - 2 - ((v - lo) / (hi - lo)) * (h - 4);
  const d = points.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <line x1="2" x2={w - 2} y1={y(1500)} y2={y(1500)} stroke="var(--line-strong)" strokeDasharray="2 3" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(points.length - 1)} cy={y(points[points.length - 1])} r="2.4" fill={color} />
    </svg>
  );
}

export function Standings({ ratings, rounds, roster, identities }: { ratings: Rating[]; rounds: Round[]; roster: RosterAgent[]; identities: Identity[] }) {
  const hist = histories(rounds);
  const rows = [...ratings].sort((a, b) => b.rating - a.rating);
  return (
    <div className="panel">
      <table>
        <thead>
          <tr>
            <th className="num" style={{ width: 36 }}>
              #
            </th>
            <th>Agent</th>
            <th className="num">Rating</th>
            <th className="hide-sm">Trend</th>
            <th className="hide-sm">Form</th>
            <th className="num">W / R</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const id = short(r.agent);
            const a = roster.find((x) => x.id === id);
            const h = hist.get(r.agent);
            const ident = identities.find((x) => x.agent === r.agent);
            const color = hueColor(ident);
            return (
              <tr key={r.agent} style={{ ["--agent" as string]: color }}>
                <td className="num muted">{i + 1}</td>
                <td>
                  <div className="who-cell">
                    {ident ? <Identicon cells={ident.cells} palette={ident.palette} size={28} /> : <span style={{ width: 26 }} />}
                    <div>
                      <div className="n">{a?.name ?? id}</div>
                      <div className="m">{a?.model ?? r.agent}</div>
                    </div>
                  </div>
                </td>
                <td className="num">
                  <div className="rating">{(r.rating / 100).toFixed(1)}</div>
                  {h?.last !== null && h?.last !== undefined && (
                    <div className={`delta ${h.last >= 0 ? "up" : "down"}`} style={{ fontSize: 12 }}>
                      {h.last >= 0 ? "+" : ""}
                      {h.last.toFixed(1)}
                    </div>
                  )}
                </td>
                <td className="hide-sm">
                  <Spark points={h?.points ?? []} color={color} />
                </td>
                <td className="hide-sm">
                  <span className="form" aria-label={`${r.wins} wins in ${r.rounds} rounds`}>
                    {(h?.form ?? []).slice(-8).map((w, k) => (
                      <i key={k} data-w={w} />
                    ))}
                  </span>
                </td>
                <td className="num">
                  {r.wins} / {r.rounds}
                  {r.provisional && <div className="muted" style={{ fontSize: 11 }}>provisional</div>}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="empty">
                No settled rounds yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Scouts({ bettors, records }: { bettors: Bettor[]; records: RoundRecord[] }) {
  const latest = new Map<string, { reasoning: string; kind: string; round: number }>();
  for (const rec of [...records].sort((a, b) => a.roundId - b.roundId)) {
    for (const e of rec.events) {
      if (e.kind === "scout_bet") latest.set(e.data.scout, { reasoning: e.data.reasoning, kind: e.data.kind, round: rec.roundId });
    }
  }
  const scouts = bettors.filter((b) => short(b.account).startsWith("scout-"));
  scouts.sort((a, b) => (BigInt(b.pnl) > BigInt(a.pnl) ? 1 : BigInt(b.pnl) < BigInt(a.pnl) ? -1 : 0));
  return (
    <div className="panel">
      <table>
        <thead>
          <tr>
            <th>Scout</th>
            <th className="num">PnL</th>
            <th className="num">Hits</th>
          </tr>
        </thead>
        <tbody>
          {scouts.map((s) => {
            const pnl = BigInt(s.pnl);
            const l = latest.get(s.account);
            return (
              <tr key={s.account}>
                <td>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ fontWeight: 600 }}>{short(s.account)}</span>
                    <span className={`badge ${l?.kind === "llm" ? "model" : ""}`}>{l?.kind === "llm" ? "model" : "scripted"}</span>
                  </div>
                  {l && (
                    <div className="quote" style={{ marginTop: 6 }}>
                      <span className="muted mono" style={{ fontSize: 11 }}>
                        R{l.round}{" "}
                      </span>
                      {l.reasoning}
                    </div>
                  )}
                </td>
                <td className={`num pnl ${pnl > 0n ? "up" : pnl < 0n ? "down" : ""}`}>
                  {pnl > 0n ? "+" : ""}
                  {near(pnl)}
                  <div className="muted" style={{ fontSize: 11 }}>
                    staked {near(s.staked)}
                  </div>
                </td>
                <td className="num">
                  {s.wins}/{s.bets}
                </td>
              </tr>
            );
          })}
          {scouts.length === 0 && (
            <tr>
              <td colSpan={3} className="empty">
                No scout bets yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
