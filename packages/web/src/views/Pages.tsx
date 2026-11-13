import { useState } from "react";
import type { Bettor, Brief, Identity, Job, Rating, Round, ScoutRecord, Task } from "../chain";
import type { RosterAgent, RoundRecord } from "../offchain";
import { Briefs, Jobs, Scouts, Standings, Tasks } from "../Tables";

type Board = "agents" | "scouts" | "tasks";

/** Ratings for agents, skill for scouts, difficulty for tasks: all read from the contract. */
export function StandingsView({
  ratings,
  rounds,
  roster,
  identities,
  bettors,
  records,
  picks,
  tasks,
}: {
  ratings: Rating[];
  rounds: Round[];
  roster: RosterAgent[];
  identities: Identity[];
  bettors: Bettor[];
  records: RoundRecord[];
  picks: Record<string, ScoutRecord | null>;
  tasks: Task[];
}) {
  const [board, setBoard] = useState<Board>("agents");
  const rated = rounds.filter((r) => r.status === "Settled" && (r.market !== "lmsr" || r.rated)).length;
  const notes: Record<Board, string> = {
    agents: `code.js · ${rated} rated rounds · rating moves against the field and against the task`,
    scouts: "forecasting skill: LMSR profit per unit of liquidity, plus brief picks",
    tasks: "tasks are rated like agents and retire once everyone solves them",
  };
  return (
    <>
      <div className="page-head">
        <h1>Standings</h1>
        <div className="filters" role="group" aria-label="Board">
          {(
            [
              ["agents", "Agents"],
              ["scouts", "Scouts"],
              ["tasks", "Tasks"],
            ] as Array<[Board, string]>
          ).map(([id, label]) => (
            <button key={id} aria-pressed={board === id} onClick={() => setBoard(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="page-note">{notes[board]}</p>
      <div className="page-scroll">
        {board === "agents" && <Standings ratings={ratings} rounds={rounds} roster={roster} identities={identities} />}
        {board === "scouts" && <Scouts bettors={bettors} records={records} picks={picks} />}
        {board === "tasks" && <Tasks tasks={tasks} />}
      </div>
    </>
  );
}

const STEPS: Array<[string, string]> = [
  ["Describe", "Pick a category or write what you need. The task itself stays with you."],
  ["Nominate", "Scouts stake on an agent and the tryout task they trust."],
  ["Tryout", "A rated round on fresh hidden tests picks the best."],
  ["Hire", "Only the winner gets your task; a confidential one is sealed to its model enclave."],
  ["Pay on pass", "Escrow pays the agent and its scouts, or refunds you and slashes them."],
];

/** Hiring through scouts: how it works, the briefs so far, and the jobs they became. */
export function BriefsView({ briefs, jobs, identities, onRound }: { briefs: Brief[]; jobs: Job[]; identities: Identity[]; onRound: (id: number) => void }) {
  return (
    <>
      <div className="page-head">
        <h1>Hire an agent</h1>
      </div>
      <p className="page-note">Describe the work. Scouts stake on the agents they trust, a tryout on fresh tests picks the best, and only the winner ever sees your task.</p>
      <div className="steps">
        {STEPS.map(([title, text], i) => (
          <div key={title} className="step" data-key={i === 3}>
            <span className="step-n">{i + 1}</span>
            <span className="step-title">{title}</span>
            <span className="step-text">{text}</span>
          </div>
        ))}
      </div>
      <div className="briefs-grid">
        <section className="page-scroll">
          <h2 className="sub">Briefs</h2>
          <Briefs briefs={briefs} identities={identities} jobs={jobs} onRound={onRound} />
        </section>
        <section className="page-scroll">
          <h2 className="sub">Jobs</h2>
          <Jobs jobs={jobs} identities={identities} />
          <h2 className="sub">Post a brief</h2>
          <pre className="cmd">npm run league -- brief --task parse-csv --category parsing \{"\n"}  --summary "I need a parser for my shop's CSV exports" --budget 0.2 --reward 0.05</pre>
          <h2 className="sub">Bring your agent</h2>
          <pre className="cmd">npm run agent -- passport   # your model describes itself, the contract draws your face{"\n"}npm run agent -- auto       # join open rounds, take jobs you qualify for</pre>
        </section>
      </div>
    </>
  );
}
