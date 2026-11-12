import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { conflictPrompt, faceCode, figureText, parseIdentityReply, zeroPrompt, type IdentityChoice } from "@agent-league/shared";
import { IDENTITY_DEPOSIT, type LeagueChain } from "./chain.js";
import { config, DATA_DIR } from "./config.js";
import { chat, completionSignature, type ChatMessage, type CompletionSignature } from "./nearai.js";
import { agentAccount, configHash, type AgentConfig } from "./roster.js";

export interface IdentityAttempt {
  at: number;
  reply?: string;
  choice?: IdentityChoice;
  /** Face the seed produced, as the contract computed it. */
  face?: { pattern: number; hue: number };
  rejected?: string;
  completionId?: string;
  signature?: CompletionSignature | null;
}

export interface IdentityRecord {
  agent: string;
  model: string;
  zeroPromptHash: string;
  attempts: IdentityAttempt[];
  issued?: { number: number; pattern: number; hue: number; seed: string; motto: string };
}

const MAX_ATTEMPTS = 4;

function save(rec: IdentityRecord): void {
  const dir = path.join(DATA_DIR, "identities");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${rec.agent}.json`), JSON.stringify(rec, null, 2));
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * The agent writes its own seed. Every agent gets the same zero prompt (with its own system
 * prompt as the system message, since the agent is model + prompt). The contract hashes the
 * seed into the face and judges uniqueness; a rejected agent rewrites its seed.
 */
export async function issueIdentity(chain: LeagueChain, agent: AgentConfig, say: (l: string) => void = console.log): Promise<IdentityRecord> {
  const league = config.leagueAccount;
  const account = agentAccount(agent, league);
  const existing = await chain.getIdentity(account);
  if (existing) {
    say(`  ${agent.name.padEnd(7)} already has passport #${existing.number} (${existing.face_code})`);
    return { agent: account, model: agent.model, zeroPromptHash: "", attempts: [] };
  }
  // The agent pays the passport deposit and gas itself; make sure it can.
  const sent = await chain.topUp(league, account, IDENTITY_DEPOSIT + 10n ** 23n);
  if (sent > 0n) say(`  topped up ${agent.id} for its passport`);
  const zero = zeroPrompt();
  const rec: IdentityRecord = { agent: account, model: agent.model, zeroPromptHash: `sha256:${sha(zero)}`, attempts: [] };
  const messages: ChatMessage[] = [
    { role: "system", content: agent.systemPrompt },
    { role: "user", content: zero },
  ];

  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const attempt: IdentityAttempt = { at: Date.now() };
    rec.attempts.push(attempt);
    let reply;
    try {
      reply = await chat(agent.model, messages, { maxTokens: 32000, timeoutMs: 300_000 });
    } catch (e) {
      attempt.rejected = `model error: ${e instanceof Error ? e.message : e}`;
      save(rec);
      say(`  ${agent.name.padEnd(7)} attempt ${i}: ${attempt.rejected}`);
      continue;
    }
    attempt.reply = reply.content;
    attempt.completionId = reply.id;
    attempt.signature = await completionSignature(reply.id, agent.model);
    messages.push({ role: "assistant", content: reply.content });

    let choice: IdentityChoice;
    try {
      choice = parseIdentityReply(reply.content);
      attempt.choice = choice;
    } catch (e) {
      attempt.rejected = `invalid reply: ${e instanceof Error ? e.message : e}`;
      save(rec);
      say(`  ${agent.name.padEnd(7)} attempt ${i}: ${attempt.rejected}`);
      messages.push({ role: "user", content: `That was not valid (${attempt.rejected}). Reply with the JSON object only.` });
      continue;
    }

    const check = await chain.checkFace(choice.seed);
    attempt.face = { pattern: check.pattern, hue: check.hue };
    let reason = check.ok ? null : check.reason ?? "rejected";
    if (!reason) {
      const sig = attempt.signature;
      const proof = `nearai:${reply.id}:${sig?.signature_kind ?? "unsigned"}:${sig ? sha(sig.signature).slice(0, 16) : "-"}`;
      try {
        const number = Number(await chain.registerIdentity(account, account, choice.seed, choice.motto, configHash(agent), proof));
        rec.issued = { number, pattern: check.pattern, hue: check.hue, seed: choice.seed, motto: choice.motto };
        save(rec);
        say(`  ${agent.name.padEnd(7)} passport #${number} ${faceCode(check)}  "${choice.motto}"`);
        say(`            seed: ${choice.seed}`);
        for (const l of figureText(check.pattern).slice(0, 7)) say(`            ${l}`);
        return rec;
      } catch (e) {
        // Another agent may have taken a close face between the check and the call; that goes
        // back to the model. Anything else (balance, network) is not the agent's problem.
        const msg = e instanceof Error ? e.message : String(e);
        if (!/face too close/.test(msg)) {
          rec.attempts.pop();
          save(rec);
          throw e;
        }
        reason = msg;
      }
    }
    attempt.rejected = reason!;
    save(rec);
    say(`  ${agent.name.padEnd(7)} attempt ${i}: ${faceCode(check)} rejected, ${reason}`);
    messages.push({ role: "user", content: conflictPrompt(reason!) });
  }
  save(rec);
  throw new Error(`${agent.name} could not get a unique face in ${MAX_ATTEMPTS} attempts`);
}
