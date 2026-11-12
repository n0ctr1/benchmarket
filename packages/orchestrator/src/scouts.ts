import { findJsonObject, type TaskPublic } from "@agent-league/shared";
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
  /** Set when an LLM scout fell back to a scripted rule: why, and the start of the raw reply. */
  fallback?: { reason: string; reply?: string };
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

export const LLM_SCOUT_MODEL = "anthropic/claude-sonnet-5-5";

/**
 * Scout driven by a model on NEAR AI Cloud. It sees only public data (task statement, each
 * agent's model, prompt, claimed strengths, rating, rounds played and current odds) and
 * must explain its pick. Falls back to the value scout if the model's reply is unusable.
 */
export function llmScout(chatFn: (model: string, system: string, user: string) => Promise<string>, model = LLM_SCOUT_MODEL): Scout {
  return {
    id: "scout-llm",
    kind: "llm",
    async decide(task, field) {
      const system = `You are a scout in Agent League. AI agents compete on a coding task scored by hidden tests; the highest score wins.
You bet NEAR on one agent in a parimutuel market. Payout per NEAR = total pool / pool of the winner, so a correct pick on a low-odds agent pays more.
Pick the agent with the best expected value, not just the most likely winner. Use only the information given.
Reply with JSON only: {"agent": "<agent id>", "reasoning": "<two or three sentences, concrete>"}`;
      const rows = field.map((f) => ({
        id: f.config.id,
        name: f.config.name,
        model: f.config.model,
        system_prompt: f.config.systemPrompt,
        claimed_strengths: f.config.strengths,
        rating: +(f.rating / 100).toFixed(1),
        rounds_played: f.rounds,
        market_odds: `${(f.odds * 100).toFixed(1)}%`,
      }));
      const user = `Task: ${task.title} (${task.id})\n\n${task.statement}\n\nField:\n${JSON.stringify(rows, null, 2)}`;
      let text: string | undefined;
      let reason: string;
      try {
        text = await chatFn(model, system, user);
        const parsed = findJsonObject(text, "agent") as { agent?: string; reasoning?: string } | null;
        const pick = parsed && field.find((f) => f.config.id === parsed.agent || f.agent === parsed.agent);
        if (pick && typeof parsed.reasoning === "string" && parsed.reasoning.trim()) {
          return { agent: pick.agent, reasoning: parsed.reasoning.trim() };
        }
        reason = !parsed ? "no JSON object with an agent" : !pick ? `unknown agent ${JSON.stringify(parsed.agent)}` : "empty reasoning";
      } catch (e) {
        reason = `model error: ${e instanceof Error ? e.message : e}`;
      }
      const d = await valueScout.decide(task, field);
      return {
        agent: d.agent,
        reasoning: `(model reply unusable, value fallback) ${d.reasoning}`,
        fallback: { reason, reply: text?.slice(0, 600) },
      };
    },
  };
}

/** Every scout that needs an account, scripted or not. */
export const ALL_SCOUT_IDS = [...SCRIPTED_SCOUTS.map((s) => s.id), "scout-llm"];
