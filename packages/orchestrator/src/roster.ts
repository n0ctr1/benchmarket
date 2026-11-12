import { createHash } from "node:crypto";

/** One Open League agent: the full config the league knows about. */
export interface AgentConfig {
  /** Short id; the on-chain account is `<id>.<league account>`. */
  id: string;
  name: string;
  model: string;
  systemPrompt: string;
  tools: string[];
  /** Tasks the builder claims the agent is good at; public, scouts may use it. */
  strengths: string[];
  /** Scripted behavior for sim mode: share of hidden tests it gets wrong, per mille. */
  sim: { failPermille: number; strengthBonus: number };
}

const BASE_PROMPT = `You are a careful JavaScript engineer competing in Agent League.
You get one task. Write exactly one JavaScript function with the requested name.
Rules: plain JavaScript (no TypeScript), no imports, no require, no eval, no network, no console output.
Follow the specification literally, especially the rules about invalid input.
Answer with a single fenced code block and nothing else.`;

export const ROSTER: AgentConfig[] = [
  {
    id: "atlas",
    name: "Atlas",
    model: "deepseek/deepseek-v4.1-flash",
    systemPrompt: BASE_PROMPT,
    tools: [],
    strengths: ["eval-expr", "semver-satisfies"],
    sim: { failPermille: 120, strengthBonus: 100 },
  },
  {
    id: "bolt",
    name: "Bolt",
    model: "Qwen/Qwen3.8-27B",
    systemPrompt: BASE_PROMPT + "\nBe fast and concise.",
    tools: [],
    strengths: ["parse-duration"],
    sim: { failPermille: 260, strengthBonus: 150 },
  },
  {
    id: "cipher",
    name: "Cipher",
    model: "z-ai/glm-5.3-flash",
    systemPrompt:
      BASE_PROMPT +
      "\nBefore writing code, list every edge case in the spec as comments at the top of the function, then handle each one.",
    tools: [],
    strengths: ["parse-csv", "cron-next"],
    sim: { failPermille: 180, strengthBonus: 170 },
  },
  {
    id: "delta",
    name: "Delta",
    model: "openai/gpt-6-luna",
    systemPrompt: BASE_PROMPT,
    tools: [],
    strengths: ["cron-next"],
    sim: { failPermille: 150, strengthBonus: 60 },
  },
  {
    id: "echo",
    name: "Echo",
    model: "anthropic/claude-haiku-5-5",
    systemPrompt: BASE_PROMPT + "\nPrefer a small hand-written parser over regular expressions.",
    tools: [],
    strengths: ["eval-expr", "parse-csv"],
    sim: { failPermille: 300, strengthBonus: 220 },
  },
];

export function agentAccount(a: AgentConfig, parent: string): string {
  return `${a.id}.${parent}`;
}

/** Hash of the public config, recorded on chain at registration. */
export function configHash(a: AgentConfig): string {
  const pub = { name: a.name, model: a.model, systemPrompt: a.systemPrompt, tools: a.tools };
  return "sha256:" + createHash("sha256").update(JSON.stringify(pub)).digest("hex");
}
