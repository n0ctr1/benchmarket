import { near, short, type Bettor, type Brief, type Identity, type Job, type Rating, type Round, type ScoutRecord, type Task } from "./chain";
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
    if (r.status !== "Settled" || (r.market === "lmsr" && !r.rated)) continue;
    for (const e of r.entries) {
      const h = out.get(e.agent) ?? { points: [e.rating_before / 100], form: [], last: null };
      h.points.push((e.rating_before + e.rating_delta) / 100);
      h.form.push(r.winners.includes(e.agent));
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
                  {(r.attested > 0 || r.jobs_done + r.jobs_failed > 0) && (
                    <div className="muted" style={{ fontSize: 11 }} title="Rounds and jobs with an answer the contract verified as a NEAR AI completion; paid jobs of all jobs">
                      {r.attested > 0 && `${r.attested} attested`}
                      {r.attested > 0 && r.jobs_done + r.jobs_failed > 0 && " · "}
                      {r.jobs_done + r.jobs_failed > 0 && `jobs ${r.jobs_done}/${r.jobs_done + r.jobs_failed}`}
                    </div>
                  )}
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

export function Scouts({ bettors, records, picks = {} }: { bettors: Bettor[]; records: RoundRecord[]; picks?: Record<string, ScoutRecord | null> }) {
  const latest = new Map<string, { reasoning: string; kind: string; round: number }>();
  for (const rec of [...records].sort((a, b) => a.roundId - b.roundId)) {
    for (const e of rec.events) {
      if (e.kind === "scout_bet") latest.set(e.data.scout, { reasoning: e.data.reasoning, kind: e.data.kind, round: rec.roundId });
    }
  }
  const scouts = bettors.filter((b) => short(b.account).startsWith("scout-"));
  scouts.sort((a, b) => b.skill_ppm - a.skill_ppm || (BigInt(b.pnl) > BigInt(a.pnl) ? 1 : BigInt(b.pnl) < BigInt(a.pnl) ? -1 : 0));
  return (
    <div className="panel">
      <table>
        <thead>
          <tr>
            <th>Scout</th>
            <th className="num" title="LMSR profit per unit of liquidity: a log-score of forecasting skill that does not grow with bet size">Skill</th>
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
                <td className={`num pnl ${s.skill_ppm > 0 ? "up" : s.skill_ppm < 0 ? "down" : ""}`}>
                  {s.scored_rounds ? `${s.skill_ppm > 0 ? "+" : ""}${(s.skill_ppm / 1e6).toFixed(2)}` : "—"}
                  <div className="muted" style={{ fontSize: 11 }}>
                    {s.scored_rounds} LMSR rounds
                  </div>
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
                  {picks[s.account] && picks[s.account]!.nominated > 0 && (
                    <div className="muted" style={{ fontSize: 11 }} title="Brief nominations: hired, and of those delivered">
                      picks {picks[s.account]!.hired}/{picks[s.account]!.nominated} hired · {picks[s.account]!.delivered} delivered
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
          {scouts.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                No scout bets yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Task pool by difficulty: tasks are rated like agents, and retire once everyone solves them. */
export function Tasks({ tasks }: { tasks: Task[] }) {
  const rows = [...tasks].sort((a, b) => b.rating - a.rating);
  return (
    <div className="panel">
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th className="num" title="An agent rated the same is expected to pass half the hidden tests">Difficulty</th>
            <th className="num">Rounds</th>
            <th className="num">Jobs</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.task_ref}>
              <td>
                <span className="mono" style={{ fontWeight: 600 }}>
                  {t.task_ref}
                </span>{" "}
                {!t.curated && <span className="badge">uncurated</span>}
                {t.retired && <span className="badge">retired</span>}
              </td>
              <td className="num">
                <div className="rating">{(t.rating / 100).toFixed(1)}</div>
              </td>
              <td className="num">{t.rounds}</td>
              <td className="num">{t.jobs}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                No tasks yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const JOB_STATE: Record<Job["status"], string> = {
  Open: "open",
  Taken: "in progress",
  Answered: "answered",
  Proposed: "scored, dispute window",
  Disputed: "disputed",
  Paid: "paid",
  Failed: "failed, refunded",
  Cancelled: "cancelled",
};

/** Hiring with escrow: a rating bar to take the job, payment only if hidden tests pass. */
export function Jobs({ jobs, identities }: { jobs: Job[]; identities: Identity[] }) {
  return (
    <div className="panel">
      <table>
        <thead>
          <tr>
            <th>Job</th>
            <th>Agent</th>
            <th className="num">Budget</th>
            <th className="num">Result</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => {
            const ident = j.agent ? identities.find((x) => x.agent === j.agent) : undefined;
            return (
              <tr key={j.id} style={{ ["--agent" as string]: hueColor(ident) }}>
                <td>
                  <div style={{ fontWeight: 600 }}>
                    #{j.id} <span className="mono">{j.task_ref}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    rating {j.min_rating}+ · pays at {(j.pass_ppm / 1e4).toFixed(0)}% of tests
                  </div>
                </td>
                <td>
                  <div className="who-cell">
                    {ident && <Identicon cells={ident.cells} palette={ident.palette} size={24} />}
                    <span>{j.agent ? short(j.agent) : "—"}</span>
                    {j.answer_attested && <span className="badge model">attested</span>}
                  </div>
                </td>
                <td className="num">{near(j.budget)}</td>
                <td className="num">
                  <div>{j.score !== null ? `${j.score}/${j.total_tests}` : "—"}</div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {JOB_STATE[j.status]}
                    {(j.status === "Paid" || j.status === "Failed") && ` · ${j.rating_delta >= 0 ? "+" : ""}${(j.rating_delta / 100).toFixed(1)}`}
                  </div>
                </td>
              </tr>
            );
          })}
          {jobs.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                No jobs posted yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const BRIEF_STATE: Record<Brief["status"], string> = {
  Scouting: "scouts nominating",
  Tryout: "tryout round running",
  Offered: "offer to the client",
  Hired: "hired, job running",
  Delivered: "delivered, scouts paid",
  Failed: "failed, scouts slashed",
  Declined: "client declined",
  Cancelled: "cancelled, refunded",
};

/** A client's brief from nominations to the hire: who put whom forward, and how it paid off. */
export function Briefs({ briefs, identities, jobs, onRound }: { briefs: Brief[]; identities: Identity[]; jobs: Job[]; onRound: (id: number) => void }) {
  if (briefs.length === 0) return <div className="panel empty">No briefs yet.</div>;
  return (
    <div className="briefs">
      {briefs.map((b) => {
        const job = jobs.find((j) => j.id === b.job_id);
        const closed = b.status === "Delivered" || b.status === "Failed" || b.status === "Declined" || b.status === "Cancelled";
        return (
          <article key={b.id} className="panel brief" data-s={b.status}>
            <div className="brief-head">
              <span className="mono muted">
                BRIEF {String(b.id).padStart(2, "0")}
                {b.category && ` · ${b.category}`}
              </span>
              {b.confidential && (
                <span className="badge model" title="The task goes end-to-end encrypted into the hired model's enclave only">
                  confidential
                </span>
              )}
              <span className="status" data-s={b.status}>
                {BRIEF_STATE[b.status]}
              </span>
            </div>
            <p className="brief-summary">“{b.summary}”</p>
            <div className="muted" style={{ fontSize: 12 }}>
              {short(b.client)} · budget {near(b.budget)} · scout reward {near(b.scout_reward)} · tryout {near(BigInt(b.tryout_bounty) + BigInt(b.tryout_subsidy))} NEAR
            </div>
            <ol className="funnel">
              <li>
                <b>Nominations</b>
                <ul>
                  {b.nominations.map((n, i) => {
                    const ident = identities.find((x) => x.agent === n.agent);
                    const isHire = n.agent === b.offered && (b.status === "Hired" || closed);
                    const payout = BigInt(n.payout);
                    const result = !closed ? "" : payout === 0n ? "lost stake" : payout > BigInt(n.stake) ? `+${near(payout - BigInt(n.stake))}` : "stake back";
                    return (
                      <li key={i} style={{ ["--agent" as string]: hueColor(ident) }} data-hire={isHire}>
                        <span className="who">{short(n.scout)}</span> backs {ident && <Identicon cells={ident.cells} palette={ident.palette} size={16} />} <span className="pick">{short(n.agent)}</span>{" "}
                        <span className="mono muted">on {n.task_ref}</span> <span className="amt">{near(n.stake)}</span>
                        {result && <span className={`delta ${payout > BigInt(n.stake) ? "up" : payout === 0n ? "down" : ""}`}> {result}</span>}
                      </li>
                    );
                  })}
                </ul>
              </li>
              {b.tryout_round && (
                <li>
                  <b>Tryout</b>{" "}
                  <button className="linkish" onClick={() => onRound(b.tryout_round!)}>
                    round {b.tryout_round}
                  </button>{" "}
                  <span className="mono muted">on {b.tryout_task}</span>
                </li>
              )}
              {b.offered && (
                <li>
                  <b>Offer</b> {short(b.offered)}
                </li>
              )}
              {job && (
                <li>
                  <b>Job</b> #{job.id} <span className="mono muted">{b.confidential ? "task sealed to the enclave" : job.task_ref}</span>: {job.score !== null ? `${job.score}/${job.total_tests}` : JOB_STATE[job.status]}
                  {job.answer_attested && <span className="badge model">attested</span>}
                </li>
              )}
            </ol>
          </article>
        );
      })}
    </div>
  );
}
