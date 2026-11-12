/** Off-chain round records written by the orchestrator and the verifier (see vite.config.ts). */

export interface RosterAgent {
  id: string;
  name: string;
  model: string;
  systemPrompt: string;
  strengths: string[];
}

export interface CompletionSignature {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: string;
  signature_kind?: string;
}

export interface AnswerMeta {
  mode: "sim" | "llm";
  model?: string;
  completionId?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  latencyMs?: number;
  signature?: CompletionSignature | null;
}

export interface AgentAnswer {
  code: string;
  meta: AnswerMeta | null;
  receivedAt: number;
  passed: number;
  total: number;
  compileError: string | null;
  tests: number[];
}

export interface LogEvent {
  at: number;
  kind: string;
  data: Record<string, any>;
}

export interface TaskPublic {
  id: string;
  title: string;
  statement: string;
  function: string;
  examples: Array<{ args: unknown[]; expected: unknown }>;
}

export interface RoundRecord {
  roundId: number;
  taskId: string;
  events: LogEvent[];
  report: { message: string; signatures: string[]; totalTests: number } | null;
  agents: Record<string, AgentAnswer>;
}

async function get<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}data/${path}`);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

export const loadRoster = () => get<RosterAgent[]>("roster.json");
export const loadRecord = (id: number) => get<RoundRecord>(`rounds/${id}.json`);

export function taskOf(rec: RoundRecord | null): TaskPublic | null {
  return (rec?.events.find((e) => e.kind === "round_created")?.data.task as TaskPublic) ?? null;
}

export interface IdentityNotes {
  model: string;
  zeroPromptHash: string;
  why: string | null;
  attempts: Array<{ face: number[] | null; motto: string | null; rejected: string | null; signatureKind: string | null }>;
}

export const loadIdentityNotes = () => get<Record<string, IdentityNotes>>("identities.json");
