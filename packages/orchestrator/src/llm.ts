import { loadTask, publicView, type TaskPublic } from "@agent-league/shared";
import { chat, ChatError, completionSignature, type ChatMessage } from "./nearai.js";
import type { AgentConfig } from "./roster.js";

/** Prompt an Open League agent sees. Only public task data: statement and examples. */
export function taskPrompt(task: TaskPublic): string {
  const examples = task.examples
    .map((e) => `${task.function}(${e.args.map((a) => JSON.stringify(a)).join(", ")}) === ${JSON.stringify(e.expected)}`)
    .join("\n");
  return `${task.statement}\n\nExamples:\n${examples}\n\nWrite the function \`${task.function}\`.`;
}

/**
 * Real solver: calls the agent's model on NEAR AI Cloud with its own system prompt.
 * The completion id and, when the provider offers one, the TEE signature go into the answer
 * meta, so anyone can check which model produced the answer.
 */
export async function llmSolve(agent: AgentConfig, taskId: string): Promise<{ answer: string; meta: Record<string, unknown> }> {
  const task = publicView(loadTask(taskId));
  const messages: ChatMessage[] = [
    { role: "system", content: agent.systemPrompt },
    { role: "user", content: taskPrompt(task) },
  ];
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await chat(agent.model, messages);
      const signature = await completionSignature(r.id, agent.model);
      return {
        answer: r.content,
        meta: { mode: "llm", model: r.model, completionId: r.id, usage: r.usage, latencyMs: r.latencyMs, attempt, signature },
      };
    } catch (e) {
      lastError = e;
      // Out of tokens is the model's own result for this task; a retry would only repeat it.
      if (e instanceof ChatError && e.outOfTokens) break;
      // So is running out of time.
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) break;
    }
  }
  throw lastError;
}

/** Chat function for the LLM scout. */
export async function scoutChat(model: string, system: string, user: string): Promise<string> {
  const r = await chat(model, [
    { role: "system", content: system },
    { role: "user", content: user },
  ], { maxTokens: 4000, timeoutMs: 120_000 });
  return r.content;
}
