import { configHash as hashConfig, type PublicConfig } from "@benchmarket/shared";

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

const BASE_PROMPT = `You are a careful JavaScript engineer competing in Benchmarket.
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
  {
    id: "flux",
    name: "Flux",
    model: "google/gemini-3.1-flash-lite",
    systemPrompt: BASE_PROMPT + "\nWrite the shortest correct solution you can; avoid helper functions unless they remove duplication.",
    tools: [],
    strengths: ["wrap-text", "parse-query"],
    sim: { failPermille: 210, strengthBonus: 120 },
  },
  {
    id: "gale",
    name: "Gale",
    model: "openai/gpt-5-nano",
    systemPrompt: BASE_PROMPT,
    tools: [],
    strengths: ["lru-trace"],
    sim: { failPermille: 340, strengthBonus: 160 },
  },
  {
    id: "halo",
    name: "Halo",
    model: "openai/gpt-5.6-luna",
    systemPrompt: BASE_PROMPT + "\nValidate every argument first and return the invalid-input result early.",
    tools: [],
    strengths: ["json-pointer", "split-bill"],
    sim: { failPermille: 140, strengthBonus: 90 },
  },
  {
    id: "iris",
    name: "Iris",
    model: "Qwen/Qwen3.6-35B-A3B-FP8",
    systemPrompt: BASE_PROMPT + "\nThink about integer overflow and exact arithmetic before anything else.",
    tools: [],
    strengths: ["split-bill", "shortest-path"],
    sim: { failPermille: 230, strengthBonus: 170 },
  },
  {
    id: "jade",
    name: "Jade",
    model: "google/gemini-2.5-flash-lite",
    systemPrompt: BASE_PROMPT,
    tools: [],
    strengths: ["glob-match"],
    sim: { failPermille: 280, strengthBonus: 140 },
  },
  {
    id: "kite",
    name: "Kite",
    model: "openai/gpt-5.4-nano",
    systemPrompt: BASE_PROMPT + "\nWork through the three examples by hand before you write the function.",
    tools: [],
    strengths: ["semver-satisfies", "glob-match"],
    sim: { failPermille: 250, strengthBonus: 110 },
  },
  {
    id: "lumen",
    name: "Lumen",
    model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
    systemPrompt: BASE_PROMPT + "\nWrite the tests you would run as comments first, then the function that passes them.",
    tools: [],
    strengths: ["eval-expr", "shortest-path"],
    sim: { failPermille: 160, strengthBonus: 130 },
  },
  {
    id: "mono",
    name: "Mono",
    model: "z-ai/glm-5.3-flash",
    systemPrompt: BASE_PROMPT + "\nRead the specification like a contract: every sentence is a requirement, and anything not allowed is invalid.",
    tools: [],
    strengths: ["parse-query", "json-pointer", "parse-duration"],
    sim: { failPermille: 190, strengthBonus: 150 },
  },
];

export function agentAccount(a: AgentConfig, parent: string): string {
  return `${a.id}.${parent}`;
}

/** The part of the config the agent publishes; its hash goes on chain at registration. */
export function publicConfig(a: AgentConfig): PublicConfig {
  return { name: a.name, model: a.model, systemPrompt: a.systemPrompt, tools: a.tools };
}

export function configHash(a: AgentConfig): string {
  return hashConfig(publicConfig(a));
}
