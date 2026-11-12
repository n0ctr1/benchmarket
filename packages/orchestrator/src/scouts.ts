import type { TaskPublic } from "@agent-league/shared";
import type { AgentConfig } from "./roster.js";

export interface ScoutFieldEntry {
  agent: string;
  config: AgentConfig;
  rating: number;
  rounds: number;
  /** Current market share of the agent's pool, 0..1. */
  odds: number;
}

export interface ScoutDecision {
  agent: string;
  reasoning: string;
}

export interface Scout {
  id: string;
  kind: "scripted" | "llm";
  decide(task: TaskPublic, field: ScoutFieldEntry[]): Promise<ScoutDecision>;
}

function priorShares(field: ScoutFieldEntry[]): number[] {
  const w = field.map((f) => Math.pow(10, f.rating / 100 / 400));
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / s);
}

/** Backs the highest-rated agent. */
export const favoriteScout: Scout = {
  id: "scout-fav",
  kind: "scripted",
  async decide(_task, field) {
    const best = [...field].sort((a, b) => b.rating - a.rating || a.agent.localeCompare(b.agent))[0];
    return { agent: best.agent, reasoning: `Highest rating in the field (${(best.rating / 100).toFixed(1)}).` };
  },
};

/** Backs the agent whose rating-implied chance most exceeds its current market share. */
export const valueScout: Scout = {
  id: "scout-value",
  kind: "scripted",
  async decide(_task, field) {
    const prior = priorShares(field);
    let best = 0;
    for (let i = 1; i < field.length; i++) {
      if (prior[i] - field[i].odds > prior[best] - field[best].odds) best = i;
    }
    const f = field[best];
    return {
      agent: f.agent,
      reasoning: `Rating implies ${(prior[best] * 100).toFixed(0)}% but the market prices ${(f.odds * 100).toFixed(0)}%: underpriced.`,
    };
  },
};

/** Backs an agent whose builder lists this task as a strength; ties go to the lower odds. */
export const specialistScout: Scout = {
  id: "scout-spec",
  kind: "scripted",
  async decide(task, field) {
    const fits = field.filter((f) => f.config.strengths.includes(task.id));
    const pool = fits.length > 0 ? fits : field;
    const pick = [...pool].sort((a, b) => a.odds - b.odds || a.agent.localeCompare(b.agent))[0];
    return {
      agent: pick.agent,
      reasoning:
        fits.length > 0
          ? `${pick.config.name} lists ${task.id} as a strength and is the cheapest such agent.`
          : `Nobody claims ${task.id}; taking the cheapest agent.`,
    };
  },
};

export const SCRIPTED_SCOUTS: Scout[] = [favoriteScout, valueScout, specialistScout];
