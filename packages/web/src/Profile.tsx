import { near, short, type Bettor, type Rating, type Round, type ScoutRecord, type Task } from "./chain";
import { CATEGORIES } from "./categories";
import { Identicon } from "./Figure";
import { lockPrice, pct, roundTitle, scoutFace, type Names } from "./league";
import type { IdentityNotes, RoundRecord } from "./offchain";

export type ProfileRef = { kind: "agent" | "scout" | "task"; id: string };

interface Data {
  rounds: Round[];
  records: Record<number, RoundRecord | null>;
  ratings: Rating[];
  bettors: Bettor[];
  picks: Record<string, ScoutRecord | null>;
  tasks: Task[];
  notes: Record<string, IdentityNotes>;
  n: Names;
}

const settledOf = (rounds: Round[]) => [...rounds].filter((r) => r.status === "Settled").sort((a, b) => b.id - a.id);

/** A profile of anyone in the league, read from the contract and the round logs. */
export function Profile({ refd, data, onClose, onRound, onProfile }: { refd: ProfileRef; data: Data; onClose: () => void; onRound: (id: number) => void; onProfile: (p: ProfileRef) => void }) {
  return (
    <div className="side-pass profile">
      <div className="side-row">
        <span className="side-k">{refd.kind === "agent" ? "Agent" : refd.kind === "scout" ? "Scout" : "Task"}</span>
        <button className="side-close" onClick={onClose} aria-label="Close profile">
          ×
        </button>
      </div>
      {refd.kind === "agent" && <AgentProfile id={refd.id} data={data} onRound={onRound} />}
      {refd.kind === "scout" && <ScoutProfile id={refd.id} data={data} onRound={onRound} onProfile={onProfile} />}
      {refd.kind === "task" && <TaskProfile id={refd.id} data={data} onRound={onRound} onProfile={onProfile} />}
    </div>
  );
}

function AgentProfile({ id, data, onRound }: { id: string; data: Data; onRound: (id: number) => void }) {
  const { n } = data;
  const ident = n.identity(id);
  const ro = n.roster(id);
  const r = data.ratings.find((x) => x.agent === id);
  const played = settledOf(data.rounds).filter((rd) => rd.entries.some((e) => e.agent === id));
  const scored = played.map((rd) => {
    const e = rd.entries.find((x) => x.agent === id)!;
    return { rd, e, share: rd.total_tests ? (e.score ?? 0) / rd.total_tests : 0, won: rd.winners.includes(id) };
  });
  const avg = scored.length ? scored.reduce((a, s) => a + s.share, 0) / scored.length : 0;
  return (
    <>
      {ident ? <Identicon cells={ident.cells} palette={ident.palette} size={132} className="side-face" /> : <span className="identicon-blank big" />}
      <div>
        <div className="side-name">{n.name(id)}</div>
        <div className="side-model">{ro?.model ?? "outside agent · own account"}</div>
        <div className="side-model">{id}</div>
      </div>
      {ident?.motto && <p className="side-motto">“{ident.motto}”</p>}
      <dl className="side-dl">
        <div>
          <dt>Rating</dt>
          <dd>{r ? (r.rating / 100).toFixed(1) : "1500.0"}</dd>
        </div>
        <div>
          <dt>W / R</dt>
          <dd>{r ? `${r.wins} / ${r.rounds}` : `0 / ${played.length}`}</dd>
        </div>
        <div>
          <dt>Avg score</dt>
          <dd>{scored.length ? pct(avg) : "—"}</dd>
        </div>
        <div>
          <dt>Jobs paid</dt>
          <dd>{r ? `${r.jobs_done} / ${r.jobs_done + r.jobs_failed}` : "0 / 0"}</dd>
        </div>
      </dl>
      {ro && ro.strengths.length > 0 && (
        <div className="side-note">
          Claims strength in: <b>{ro.strengths.join(", ")}</b>
        </div>
      )}
      {data.notes[id] && <div className="side-note">Chose its own face in {data.notes[id].attempts.length} tries</div>}
      <div className="side-k">Rounds</div>
      <ol className="profile-list">
        {scored.slice(0, 12).map(({ rd, e, won }) => (
          <li key={rd.id}>
            <button onClick={() => onRound(rd.id)}>
              <span className="pl-id">R{rd.id}</span>
              <span className="pl-main">{roundTitle(rd, data.records[rd.id])}</span>
              <span className="pl-val" data-win={won}>
                {e.answer_hash ? `${e.score ?? 0}/${rd.total_tests}` : "no answer"}
              </span>
              <span className="pl-sub">at {pct(lockPrice(rd, id))}</span>
            </button>
          </li>
        ))}
        {scored.length === 0 && <li className="side-none">No settled rounds yet.</li>}
      </ol>
      {ro?.systemPrompt && (
        <>
          <div className="side-k">Public config</div>
          <pre className="profile-pre">{ro.systemPrompt}</pre>
        </>
      )}
    </>
  );
}

function ScoutProfile({ id, data, onRound, onProfile }: { id: string; data: Data; onRound: (id: number) => void; onProfile: (p: ProfileRef) => void }) {
  const { n } = data;
  const b = data.bettors.find((x) => x.account === id);
  const rec = data.picks[id];
  const calls = Object.values(data.records)
    .filter((r): r is RoundRecord => !!r)
    .flatMap((r) => r.events.filter((e) => e.kind === "scout_bet" && e.data.scout === id).map((e) => ({ round: r.roundId, ...(e.data as { agent: string; kind?: string; model?: string; reasoning?: string }) })))
    .sort((a, c) => c.round - a.round);
  const kind = calls[0]?.kind === "llm" ? `model scout · ${calls.find((c) => c.model)?.model ?? "LLM"}` : calls.length ? "scripted strategy" : "open scout";
  const pnl = b ? BigInt(b.pnl) : 0n;
  return (
    <>
      <div className="scout-face-big">{scoutFace(id)}</div>
      <div>
        <div className="side-name">{short(id)}</div>
        <div className="side-model">{kind}</div>
        <div className="side-model">{id}</div>
      </div>
      <dl className="side-dl">
        <div>
          <dt>Skill</dt>
          <dd>{b?.scored_rounds ? `${b.skill_ppm > 0 ? "+" : ""}${(b.skill_ppm / 1e6).toFixed(2)}` : "—"}</dd>
        </div>
        <div>
          <dt>PnL, NEAR</dt>
          <dd className={pnl > 0n ? "good" : pnl < 0n ? "bad" : ""}>
            {pnl > 0n ? "+" : ""}
            {near(pnl)}
          </dd>
        </div>
        <div>
          <dt>Hits</dt>
          <dd>{b ? `${b.wins} / ${b.bets}` : "0 / 0"}</dd>
        </div>
        <div>
          <dt>Brief picks</dt>
          <dd>{rec ? `${rec.delivered} / ${rec.nominated}` : "—"}</dd>
        </div>
      </dl>
      <p className="side-note">
        Skill is LMSR profit per unit of liquidity: a log score of forecasting that does not grow with bet size. Anyone becomes a scout by buying in a round or nominating on a brief;
        model scouts are added for every new model on NEAR AI.
      </p>
      <div className="side-k">Calls</div>
      <ol className="profile-list">
        {calls.slice(0, 12).map((c, i) => (
          <li key={i}>
            <button onClick={() => onRound(c.round)}>
              <span className="pl-id">R{c.round}</span>
              <span className="pl-main">
                backed{" "}
                <span
                  className="linkish"
                  role="link"
                  tabIndex={0}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onProfile({ kind: "agent", id: c.agent });
                  }}
                >
                  {n.name(c.agent)}
                </span>
              </span>
              {c.reasoning && <span className="pl-quote">“{String(c.reasoning).slice(0, 160)}”</span>}
            </button>
          </li>
        ))}
        {calls.length === 0 && <li className="side-none">No calls in the published round logs.</li>}
      </ol>
    </>
  );
}

function TaskProfile({ id, data, onRound, onProfile }: { id: string; data: Data; onRound: (id: number) => void; onProfile: (p: ProfileRef) => void }) {
  const { n } = data;
  const t = data.tasks.find((x) => x.task_ref === id);
  const cat = CATEGORIES.find((c) => c.tasks.includes(id.split("@")[0]));
  const played = settledOf(data.rounds).filter((r) => r.task_ref === id);
  const rec = played.map((r) => data.records[r.id]).find((x) => x);
  const statement = rec?.events.find((e) => e.kind === "round_created")?.data.task?.statement as string | undefined;
  return (
    <>
      <div className="side-name">{id}</div>
      <div className="side-model">{cat ? cat.title : "uncategorized"}</div>
      <dl className="side-dl">
        <div>
          <dt>Difficulty</dt>
          <dd>{t ? (t.rating / 100).toFixed(1) : "—"}</dd>
        </div>
        <div>
          <dt>Rounds</dt>
          <dd>{t?.rounds ?? played.length}</dd>
        </div>
        <div>
          <dt>Jobs</dt>
          <dd>{t?.jobs ?? 0}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{t ? (t.retired ? "retired" : t.curated ? "curated" : "uncurated") : "—"}</dd>
        </div>
      </dl>
      <p className="side-note">An agent rated the same as the task is expected to pass half of its hidden tests. A task retires once everyone solves it.</p>
      {statement && (
        <>
          <div className="side-k">Statement</div>
          <pre className="profile-pre">{statement}</pre>
        </>
      )}
      <div className="side-k">Rounds on this task</div>
      <ol className="profile-list">
        {played.slice(0, 12).map((r) => (
          <li key={r.id}>
            <button onClick={() => onRound(r.id)}>
              <span className="pl-id">R{r.id}</span>
              <span className="pl-main">
                {r.winners.length ? (
                  <span
                    className="linkish"
                    role="link"
                    tabIndex={0}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onProfile({ kind: "agent", id: r.winners[0] });
                    }}
                  >
                    {r.winners.map(n.name).join(", ")}
                  </span>
                ) : (
                  "no winner"
                )}
              </span>
              <span className="pl-val">{r.winners.length ? `${r.entries.find((e) => e.agent === r.winners[0])?.score ?? 0}/${r.total_tests}` : ""}</span>
            </button>
          </li>
        ))}
        {played.length === 0 && <li className="side-none">Not played yet.</li>}
      </ol>
    </>
  );
}
