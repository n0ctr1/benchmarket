import { findJsonObject, type TaskPublic } from "@agent-league/shared";
import type { AgentConfig } from "./roster.js";

export interface ScoutFieldEntry {
  agent: string;
  config: AgentConfig;
  rating: number;
  rounds: number;
  /** Current market price of the agent's shares, 0..1 (the market's win probability). */
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
  /** For a client's brief: which agents to put forward, and which curated task to try them on. */
  nominate?(brief: BriefInfo, field: ScoutFieldEntry[], tasks: TryoutTask[]): Promise<ScoutNomination[]>;
}

export interface BriefInfo {
  summary: string;
  skill: string;
  /** The category the client picked, with its description. */
  category?: string;
}

/** A curated task a scout may pick for the tryout. */
export interface TryoutTask {
  id: string;
  title: string;
  statement: string;
  /** Difficulty rating, centi-points. */
  rating: number;
}

export interface ScoutNomination {
  agent: string;
  task: string;
  reasoning: string;
  fallback?: { reason: string; reply?: string };
}

const words = (t: string) => new Set(t.toLowerCase().match(/[a-z]{3,}/g) ?? []);

/** The curated task closest to the brief by shared words; ties go to the harder task. */
export function closestTask(brief: BriefInfo, tasks: TryoutTask[]): TryoutTask {
  const want = words(`${brief.summary} ${brief.category ?? ""}`);
  const score = (t: TryoutTask) => [...words(`${t.title} ${t.statement}`)].filter((w) => want.has(w)).length;
  return [...tasks].sort((a, b) => score(b) - score(a) || b.rating - a.rating || a.id.localeCompare(b.id))[0];
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
  async nominate(brief, field, tasks) {
    const t = closestTask(brief, tasks);
    const best = [...field].sort((a, b) => b.rating - a.rating || a.agent.localeCompare(b.agent))[0];
    return [{ agent: best.agent, task: t.id, reasoning: `Best rated agent in ${brief.skill} (${(best.rating / 100).toFixed(1)}); ${t.id} is the closest curated task to the brief.` }];
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
  async nominate(brief, field, tasks) {
    // The runner-up by rating: the favorite will be nominated anyway, value is in a second option.
    const ranked = [...field].sort((a, b) => b.rating - a.rating || a.agent.localeCompare(b.agent));
    const pick = ranked[1] ?? ranked[0];
    const t = closestTask(brief, tasks);
    return [{ agent: pick.agent, task: t.id, reasoning: `${pick.config.name} is second by rating and will cost less to back; worth a tryout on ${t.id}.` }];
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
  async nominate(brief, field, tasks) {
    // Picks the task first, then every agent whose builder claims it.
    const t = closestTask(brief, tasks);
    const fits = field.filter((f) => f.config.strengths.includes(t.id));
    const picks = fits.length ? fits : [[...field].sort((a, b) => b.rating - a.rating)[0]];
    return picks.slice(0, 2).map((f) => ({
      agent: f.agent,
      task: t.id,
      reasoning: fits.length ? `${t.id} matches the brief and ${f.config.name} lists it as a strength.` : `${t.id} matches the brief; nobody claims it, so the best rated agent.`,
    }));
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
You buy shares of one agent from an automated market maker. A share costs its current price (the market's win probability) and pays 1 if that agent wins (split if several tie).
You profit when your probability for an agent is higher than its price, so pick the agent with the biggest gap, not just the most likely winner. Use only the information given.
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
    async nominate(brief, field, tasks) {
      const system = `You are a scout in Agent League. A client needs an AI agent for a task; it describes the task but shows it only to the agent it hires. First work out what kind of task it is. You put agents forward for a tryout and stake NEAR on each pick:
if the agent you nominated is hired and delivers, you share the client's scout reward; if it fails, you lose your stake. You also choose the curated tryout task
that best predicts success on the client's task. Use only the information given.
Reply with JSON only: {"nominations": [{"agent": "<agent id>", "task": "<task id>", "reasoning": "<one or two sentences>"}]} with one or two nominations.`;
      const rows = field.map((f) => ({ id: f.config.id, model: f.config.model, claimed_strengths: f.config.strengths, rating: +(f.rating / 100).toFixed(1), rounds_played: f.rounds }));
      const taskRows = tasks.map((t) => ({ id: t.id, title: t.title, difficulty: +(t.rating / 100).toFixed(1), statement: t.statement.slice(0, 400) }));
      const user = `Client brief (${brief.skill}): ${brief.summary}${brief.category ? `\nCategory the client picked: ${brief.category}` : ""}\n\nCurated tryout tasks:\n${JSON.stringify(taskRows, null, 2)}\n\nAgents:\n${JSON.stringify(rows, null, 2)}`;
      let text: string | undefined;
      let reason: string;
      try {
        text = await chatFn(model, system, user);
        const parsed = findJsonObject(text, "nominations") as { nominations?: Array<{ agent?: string; task?: string; reasoning?: string }> } | null;
        const out: ScoutNomination[] = [];
        for (const n of parsed?.nominations ?? []) {
          const f = field.find((x) => x.config.id === n.agent || x.agent === n.agent);
          const t = tasks.find((x) => x.id === n.task);
          if (f && t && typeof n.reasoning === "string" && n.reasoning.trim() && !out.some((o) => o.agent === f.agent)) out.push({ agent: f.agent, task: t.id, reasoning: n.reasoning.trim() });
        }
        if (out.length) return out.slice(0, 2);
        reason = parsed ? "no usable nomination" : "no JSON object with nominations";
      } catch (e) {
        reason = `model error: ${e instanceof Error ? e.message : e}`;
      }
      const d = await favoriteScout.nominate!(brief, field, tasks);
      return d.map((x) => ({ ...x, reasoning: `(model reply unusable, favorite fallback) ${x.reasoning}`, fallback: { reason, reply: text?.slice(0, 600) } }));
    },
  };
}

/** Every scout that needs an account, scripted or not. */
export const ALL_SCOUT_IDS = [...SCRIPTED_SCOUTS.map((s) => s.id), "scout-llm"];
