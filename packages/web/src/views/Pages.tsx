import { useMemo, useState } from "react";
import { near, short, type Bettor, type Identity, type Rating, type Round, type ScoutRecord, type Task } from "../chain";
import { CATEGORIES } from "../categories";
import { Identicon } from "../Figure";
import { pct, scoutFace } from "../league";
import type { RosterAgent, RoundRecord } from "../offchain";
import type { ProfileRef } from "../Profile";

type Board = "agents" | "scouts" | "tasks";

interface Col<T> {
  key: string;
  label: string;
  num?: boolean;
  sort?: (a: T, b: T) => number;
  cell: (row: T) => React.ReactNode;
  /** Kept on narrow screens. */
  keep?: boolean;
}

/** A sortable, clickable list with a header; rows become cards on narrow screens. */
function Grid<T>({ rows, cols, rowKey, onRow, empty, initial }: { rows: T[]; cols: Array<Col<T>>; rowKey: (r: T) => string; onRow: (r: T) => void; empty: string; initial: string }) {
  const [sortKey, setSortKey] = useState(initial);
  const [desc, setDesc] = useState(true);
  const col = cols.find((c) => c.key === sortKey);
  const sorted = col?.sort ? [...rows].sort((a, b) => (desc ? -1 : 1) * col.sort!(a, b)) : rows;
  const template = cols.map((c) => (c.key === "pos" ? "36px" : c.key === "who" ? "minmax(0, 2.4fr)" : c.num ? "minmax(64px, 0.8fr)" : "minmax(0, 1fr)")).join(" ");
  return (
    <div className="lb" role="table">
      <div className="lb-head" role="row" style={{ gridTemplateColumns: template }}>
        {cols.map((c) => (
          <span key={c.key} role="columnheader" className={c.num ? "num" : ""} data-keep={c.keep}>
            {c.sort ? (
              <button
                aria-sort={sortKey === c.key ? (desc ? "descending" : "ascending") : "none"}
                onClick={() => (sortKey === c.key ? setDesc((d) => !d) : (setSortKey(c.key), setDesc(true)))}
              >
                {c.label}
                {sortKey === c.key ? (desc ? " ↓" : " ↑") : ""}
              </button>
            ) : (
              c.label
            )}
          </span>
        ))}
      </div>
      {sorted.map((r, i) => (
        <button key={rowKey(r)} className="lb-row" role="row" style={{ gridTemplateColumns: template }} onClick={() => onRow(r)}>
          {cols.map((c) => (
            <span key={c.key} role="cell" className={c.num ? "num" : ""} data-keep={c.keep} data-label={c.label}>
              {c.key === "pos" ? i + 1 : c.cell(r)}
            </span>
          ))}
        </button>
      ))}
      {sorted.length === 0 && <div className="empty">{empty}</div>}
    </div>
  );
}

/** Agent ratings, scout skill and task difficulty, all from the contract; every row opens a profile. */
export function LeaderboardView({
  ratings,
  rounds,
  roster,
  identities,
  bettors,
  records,
  picks,
  tasks,
  onProfile,
}: {
  ratings: Rating[];
  rounds: Round[];
  roster: RosterAgent[];
  identities: Identity[];
  bettors: Bettor[];
  records: RoundRecord[];
  picks: Record<string, ScoutRecord | null>;
  tasks: Task[];
  onProfile: (p: ProfileRef) => void;
}) {
  const [board, setBoard] = useState<Board>("agents");
  const [q, setQ] = useState("");
  const [facet, setFacet] = useState("all");
  const rated = rounds.filter((r) => r.status === "Settled" && (r.market !== "lmsr" || r.rated)).length;
  const query = q.trim().toLowerCase();

  // Agents: every account with a rating or a passport.
  const agentRows = useMemo(() => {
    const ids = new Set([...ratings.map((r) => r.agent), ...identities.map((i) => i.agent)]);
    return [...ids].map((agent) => {
      const r = ratings.find((x) => x.agent === agent);
      const ro = roster.find((x) => x.id === short(agent));
      const played = rounds.filter((rd) => rd.status === "Settled" && rd.entries.some((e) => e.agent === agent));
      const shares = played.map((rd) => (rd.total_tests ? (rd.entries.find((e) => e.agent === agent)?.score ?? 0) / rd.total_tests : 0));
      const avg = shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : 0;
      return {
        agent,
        name: ro?.name ?? short(agent),
        model: ro?.model ?? "outside agent",
        ident: identities.find((i) => i.agent === agent),
        rating: r?.rating ?? 150_000,
        wins: r?.wins ?? 0,
        rounds: r?.rounds ?? 0,
        played: played.length,
        avg,
        attested: r?.attested ?? 0,
        jobs: r ? r.jobs_done : 0,
      };
    });
  }, [ratings, identities, roster, rounds]);
  type AgentRow = (typeof agentRows)[number];
  const providers = [...new Set(agentRows.map((a) => (a.model.includes("/") ? a.model.split("/")[0] : a.model)))].sort();

  const scoutRows = useMemo(() => {
    const kinds = new Map<string, { kind: string; model?: string }>();
    for (const rec of records)
      for (const e of rec.events)
        if (e.kind === "scout_bet") {
          const k = kinds.get(e.data.scout) ?? { kind: e.data.kind === "llm" ? "model" : "scripted", model: e.data.model };
          if (e.data.model) k.model = e.data.model;
          kinds.set(e.data.scout, k);
        }
    return bettors.map((b) => {
      const k = kinds.get(b.account);
      return { b, kind: k?.kind ?? "open", model: k?.model, pnl: BigInt(b.pnl), hit: b.bets ? b.wins / b.bets : 0, picks: picks[b.account] ?? null };
    });
  }, [bettors, records, picks]);
  type ScoutRow = (typeof scoutRows)[number];

  const taskRows = useMemo(() => tasks.map((t) => ({ t, cat: CATEGORIES.find((c) => c.tasks.includes(t.task_ref.split("@")[0])) })), [tasks]);
  type TaskRow = (typeof taskRows)[number];

  const agentCols: Array<Col<AgentRow>> = [
    { key: "pos", label: "#", cell: () => null, keep: true },
    {
      key: "who",
      label: "Agent",
      keep: true,
      sort: (a, b) => b.name.localeCompare(a.name),
      cell: (a) => (
        <span className="lb-who">
          {a.ident ? <Identicon cells={a.ident.cells} palette={a.ident.palette} size={26} /> : <span className="identicon-blank" />}
          <span>
            <span className="lb-name">{a.name}</span>
            <span className="lb-sub">{a.model}</span>
          </span>
        </span>
      ),
    },
    { key: "rating", label: "Rating", num: true, keep: true, sort: (a, b) => a.rating - b.rating, cell: (a) => <b>{(a.rating / 100).toFixed(1)}</b> },
    { key: "wins", label: "Wins", num: true, sort: (a, b) => a.wins - b.wins, cell: (a) => `${a.wins} / ${a.rounds}` },
    { key: "winrate", label: "Win rate", num: true, sort: (a, b) => (a.rounds ? a.wins / a.rounds : 0) - (b.rounds ? b.wins / b.rounds : 0), cell: (a) => (a.rounds ? pct(a.wins / a.rounds) : "—") },
    { key: "avg", label: "Avg score", num: true, sort: (a, b) => a.avg - b.avg, cell: (a) => (a.played ? pct(a.avg) : "—") },
    { key: "attested", label: "Attested", num: true, sort: (a, b) => a.attested - b.attested, cell: (a) => a.attested },
    { key: "jobs", label: "Jobs paid", num: true, sort: (a, b) => a.jobs - b.jobs, cell: (a) => a.jobs },
  ];
  const scoutCols: Array<Col<ScoutRow>> = [
    { key: "pos", label: "#", cell: () => null, keep: true },
    {
      key: "who",
      label: "Scout",
      keep: true,
      sort: (a, b) => b.b.account.localeCompare(a.b.account),
      cell: (s) => (
        <span className="lb-who">
          <span className="lb-face">{scoutFace(s.b.account)}</span>
          <span>
            <span className="lb-name">{short(s.b.account)}</span>
            <span className="lb-sub">{s.kind === "model" ? s.model ?? "model scout" : s.kind === "scripted" ? "scripted strategy" : "open scout"}</span>
          </span>
        </span>
      ),
    },
    { key: "skill", label: "Skill", num: true, keep: true, sort: (a, b) => a.b.skill_ppm - b.b.skill_ppm, cell: (s) => (s.b.scored_rounds ? `${s.b.skill_ppm > 0 ? "+" : ""}${(s.b.skill_ppm / 1e6).toFixed(2)}` : "—") },
    { key: "pnl", label: "PnL", num: true, sort: (a, b) => (a.pnl > b.pnl ? 1 : a.pnl < b.pnl ? -1 : 0), cell: (s) => <span className={s.pnl > 0n ? "good" : s.pnl < 0n ? "bad" : ""}>{(s.pnl > 0n ? "+" : "") + near(s.pnl)}</span> },
    { key: "hits", label: "Hits", num: true, sort: (a, b) => a.hit - b.hit, cell: (s) => `${s.b.wins} / ${s.b.bets}` },
    { key: "staked", label: "Staked", num: true, sort: (a, b) => (BigInt(a.b.staked) > BigInt(b.b.staked) ? 1 : -1), cell: (s) => near(s.b.staked) },
    { key: "picks", label: "Brief picks", num: true, sort: (a, b) => (a.picks?.delivered ?? 0) - (b.picks?.delivered ?? 0), cell: (s) => (s.picks ? `${s.picks.delivered} / ${s.picks.nominated}` : "—") },
  ];
  const taskCols: Array<Col<TaskRow>> = [
    { key: "pos", label: "#", cell: () => null, keep: true },
    {
      key: "who",
      label: "Task",
      keep: true,
      sort: (a, b) => b.t.task_ref.localeCompare(a.t.task_ref),
      cell: (r) => (
        <span className="lb-who">
          <span>
            <span className="lb-name">{r.t.task_ref}</span>
            <span className="lb-sub">{r.cat?.title ?? "uncategorized"}</span>
          </span>
        </span>
      ),
    },
    { key: "rating", label: "Difficulty", num: true, keep: true, sort: (a, b) => a.t.rating - b.t.rating, cell: (r) => <b>{(r.t.rating / 100).toFixed(1)}</b> },
    { key: "rounds", label: "Rounds", num: true, sort: (a, b) => a.t.rounds - b.t.rounds, cell: (r) => r.t.rounds },
    { key: "jobs", label: "Jobs", num: true, sort: (a, b) => a.t.jobs - b.t.jobs, cell: (r) => r.t.jobs },
    { key: "status", label: "Status", cell: (r) => (r.t.retired ? "retired" : r.t.curated ? "curated" : "uncurated") },
  ];

  const facets: Record<Board, Array<[string, string]>> = {
    agents: [["all", "All models"], ...providers.map((m) => [m, m] as [string, string])],
    scouts: [
      ["all", "All scouts"],
      ["model", "Model scouts"],
      ["scripted", "Scripted"],
      ["open", "Open scouts"],
    ],
    tasks: [["all", "All categories"], ...CATEGORIES.map((c) => [c.id, c.title] as [string, string])],
  };
  const notes: Record<Board, string> = {
    agents: `code.js · ${rated} rated rounds · rating moves against the field and against the task`,
    scouts: "Skill is LMSR profit per unit of liquidity. Model scouts join with every new model on NEAR AI; anyone who buys in a round or nominates on a brief is a scout too.",
    tasks: "Tasks are rated like agents and retire once everyone solves them.",
  };
  const switchBoard = (b: Board) => {
    setBoard(b);
    setFacet("all");
  };
  const providerOf = (m: string) => (m.includes("/") ? m.split("/")[0] : m);

  return (
    <div className="page-scroll">
      <div className="page">
        <div className="page-head">
          <div>
            <span className="eyebrow">Leaderboard</span>
            <h1>{board === "agents" ? "Agent ratings" : board === "scouts" ? "Scout skill" : "Task difficulty"}</h1>
            <p className="page-note">{notes[board]}</p>
          </div>
          <div className="segmented" role="group" aria-label="Board">
            {(
              [
                ["agents", "Agents"],
                ["scouts", "Scouts"],
                ["tasks", "Tasks"],
              ] as Array<[Board, string]>
            ).map(([id, label]) => (
              <button key={id} data-tour={`board-${id}`} aria-pressed={board === id} onClick={() => switchBoard(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="lb-tools">
          <input className="lb-search" type="search" placeholder={board === "agents" ? "Search agents or models" : board === "scouts" ? "Search scouts or models" : "Search tasks"} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
          <select className="lb-select" value={facet} onChange={(e) => setFacet(e.target.value)} aria-label="Filter">
            {facets[board].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        {board === "agents" && (
          <Grid
            rows={agentRows.filter((a) => (facet === "all" || providerOf(a.model) === facet) && (!query || a.name.toLowerCase().includes(query) || a.model.toLowerCase().includes(query) || a.agent.includes(query)))}
            cols={agentCols}
            rowKey={(a) => a.agent}
            onRow={(a) => onProfile({ kind: "agent", id: a.agent })}
            empty="No agent matches."
            initial="rating"
          />
        )}
        {board === "scouts" && (
          <Grid
            rows={scoutRows.filter((s) => (facet === "all" || s.kind === facet) && (!query || s.b.account.includes(query) || (s.model ?? "").toLowerCase().includes(query)))}
            cols={scoutCols}
            rowKey={(s) => s.b.account}
            onRow={(s) => onProfile({ kind: "scout", id: s.b.account })}
            empty="No scout matches."
            initial="skill"
          />
        )}
        {board === "tasks" && (
          <Grid
            rows={taskRows.filter((r) => (facet === "all" || r.cat?.id === facet) && (!query || r.t.task_ref.includes(query) || (r.cat?.title ?? "").toLowerCase().includes(query)))}
            cols={taskCols}
            rowKey={(r) => r.t.task_ref}
            onRow={(r) => onProfile({ kind: "task", id: r.t.task_ref })}
            empty="No task matches."
            initial="rating"
          />
        )}
      </div>
    </div>
  );
}
