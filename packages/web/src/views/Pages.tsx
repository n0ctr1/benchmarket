import { useState } from "react";
import type { Bettor, Identity, Rating, Round, ScoutRecord, Task } from "../chain";
import type { RosterAgent, RoundRecord } from "../offchain";
import { Scouts, Standings, Tasks } from "../Tables";

type Board = "agents" | "scouts" | "tasks";

/** Ratings for agents, skill for scouts, difficulty for tasks: all read from the contract. */
export function LeaderboardView({
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
        <h1>Leaderboard</h1>
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
