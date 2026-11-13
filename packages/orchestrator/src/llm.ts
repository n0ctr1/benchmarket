import { loadTask, publicView, taskPrompt, type Completion } from "@benchmarket/shared";
import { chat, ChatError, completionSignature, type ChatMessage, type CompletionSignature } from "./nearai.js";
import type { AgentConfig } from "./roster.js";

export interface LlmAnswer {
  /** The assistant's reply. */
  answer: string;
  /** Exact request and response bodies; NEAR AI signs their hashes. */
  completion: Completion;
  signature: CompletionSignature | null;
  meta: Record<string, unknown>;
}

/**
 * Real solver: calls the agent's model on NEAR AI Cloud with its own system prompt and the
 * round's prompt (`tag` names the round). Keeps the exact bodies and the cloud's signature, so
 * the answer can be attested on chain and checked against the agent's registered config.
 */
export async function llmSolve(agent: AgentConfig, taskId: string, tag?: string): Promise<LlmAnswer> {
  const task = publicView(loadTask(taskId));
  const messages: ChatMessage[] = [
    { role: "system", content: agent.systemPrompt },
    { role: "user", content: taskPrompt(task, tag) },
  ];
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await chat(agent.model, messages);
      const signature = await completionSignature(r.id, agent.model);
      return {
        answer: r.content,
        completion: { request: r.requestBody, response: r.responseBody },
        signature,
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
  ], { maxTokens: 12000, timeoutMs: 180_000 });
  return r.content;
}
