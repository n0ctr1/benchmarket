import fs from "node:fs";
import type { TaskWithTests } from "@benchmarket/shared";
import type { AgentConfig } from "./roster.js";

/**
 * Sim-mode solver: no LLM calls. It returns real JavaScript built from the task's reference
 * solution, wrapped so it deliberately returns a wrong value for a deterministic share of
 * inputs. The verifier runs it like any other answer, so scores, odds and ratings are real.
 */
export function simAnswer(agent: AgentConfig, task: TaskWithTests, salt: string): string {
  const reference = fs.readFileSync(task.referencePath, "utf8");
  if (task.function.startsWith("sql:")) {
    // A SQL answer is one query: right, or (by the agent's failure rate) subtly wrong.
    const bonus = agent.strengths.includes(task.id) ? agent.sim.strengthBonus : 0;
    let h = 2166136261;
    for (const ch of `${agent.id}|${salt}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    const wrong = h % 1000 < Math.max(0, agent.sim.failPermille - bonus) * 3;
    const query = wrong ? reference.trim().replace(/\bDESC\b/, "ASC").replace(/> 1800/, ">= 1800").replace(/ROWS UNBOUNDED PRECEDING\) AS low/, "ROWS 1 PRECEDING) AS low") : reference.trim();
    return "```sql\n" + query + "\n```";
  }
  const renamed = reference.replace(new RegExp(`function\\s+${task.function}\\s*\\(`), "function __reference(");
  const bonus = agent.strengths.includes(task.id) ? agent.sim.strengthBonus : 0;
  const failPermille = Math.max(0, agent.sim.failPermille - bonus);
  const seed = JSON.stringify(`${agent.id}|${salt}`);
  return [
    "```js",
    renamed,
    "",
    `function ${task.function}(...args) {`,
    `  const key = JSON.stringify(args) + ${seed};`,
    "  let h = 2166136261;",
    "  for (let i = 0; i < key.length; i++) {",
    "    h ^= key.charCodeAt(i);",
    "    h = Math.imul(h, 16777619) >>> 0;",
    "  }",
    `  if (h % 1000 < ${failPermille}) return "__wrong__";`,
    "  return __reference(...args);",
    "}",
    "```",
  ].join("\n");
}
