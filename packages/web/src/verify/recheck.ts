/**
 * Re-checks a round in the browser from public data only: the contract (over RPC) and the
 * verifier's published report. Every check records what it compared, so a reader sees the values.
 */
import { checkCompletion, completionContent, configHash, roundTag, verifyNearAiSignature, type PublicConfig } from "@agent-league/shared/inference";
import { sha256Tagged } from "@agent-league/shared/hash";
import { verifyMessage } from "@agent-league/shared/keys";
import { signedMessage, DOMAINS } from "@agent-league/shared/settlement";
import type { Round } from "../chain";
import { runInBrowser } from "./sandbox";

export interface Check {
  group: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface Published {
  report: { roundId: number; totalTests: number; scores: Array<[string, number]>; message: string; signatures: string[]; publicKeys: string[]; taskId: string };
  answers: Array<{ agent: string; answer: string; answerHash: string; request?: string; config?: PublicConfig; meta?: { signature?: { text: string; signature: string; signing_address: string; signature_kind?: string } | null } }>;
  function: string;
  rawTests: string;
  family?: { seed: string; count: number; generator: string; reference: string; familyHash: string };
}

export interface ChainConfig {
  verifiers: string[];
  inference_signers: string[];
}

const short = (s: string, n = 18) => (s.length > n ? s.slice(0, n) + "…" : s);

/** Same extraction as the verifier: the first fenced block, without `export` keywords. */
function normalizeCode(answer: string): string {
  const fence = /```[a-zA-Z]*\n([\s\S]*?)```/.exec(answer);
  const code = fence ? fence[1] : answer;
  return code.replace(/^\s*export\s+default\s+/gm, "").replace(/^\s*export\s+/gm, "");
}

function sameValue(got: unknown, expected: unknown, tol = 1e-9): boolean {
  if (typeof got === "number" && typeof expected === "number") return Math.abs(got - expected) <= tol;
  if (Array.isArray(got) || Array.isArray(expected)) {
    if (!Array.isArray(got) || !Array.isArray(expected) || got.length !== expected.length) return false;
    return got.every((g, i) => sameValue(g, expected[i], tol));
  }
  if (got && expected && typeof got === "object" && typeof expected === "object") {
    const gk = Object.keys(got).sort();
    const ek = Object.keys(expected).sort();
    if (gk.length !== ek.length || gk.some((k, i) => k !== ek[i])) return false;
    return gk.every((k) => sameValue((got as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k], tol));
  }
  return got === expected;
}

function parsed(out: string | null): { ok: boolean; value?: unknown } {
  if (out === null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(out) };
  } catch {
    return { ok: false };
  }
}

export async function recheckRound(round: Round, pub: Published, config: ChainConfig, onCheck: (c: Check) => void): Promise<Check[]> {
  const all: Check[] = [];
  const add = (group: string, label: string, ok: boolean, detail: string) => {
    const c = { group, label, ok, detail };
    all.push(c);
    onCheck(c);
  };
  const tag = roundTag("round", round.id);

  // Tests.
  const testsHash = sha256Tagged(pub.rawTests);
  add("Tests", "Published tests hash to the commitment on chain", testsHash === round.tests_hash, `sha256(tests) = ${short(testsHash, 24)}, on chain ${short(round.tests_hash, 24)}`);
  const tests = JSON.parse(pub.rawTests) as Array<{ args: unknown[]; expected: unknown }>;
  if (pub.family) {
    const famHash = "family:" + sha256Tagged(pub.family.generator + "\n" + pub.family.reference);
    add("Tests", "Generator and reference match the family hash", famHash === pub.family.familyHash, short(famHash, 34));
    const gen = await runInBrowser(pub.family.generator, "generate", [[pub.family.seed, pub.family.count]], 5000);
    const inputs = parsed(gen.results[0]?.output ?? null).value as unknown[][] | undefined;
    if (!inputs) add("Tests", "The seed regenerates the tests", false, gen.compileError ?? "generator failed");
    else {
      const ref = await runInBrowser(pub.family.reference, pub.function, inputs);
      const again = inputs.flatMap((args, i) => {
        const o = ref.results[i]?.output;
        return typeof o === "string" && !o.includes('"__') ? [{ args, expected: JSON.parse(o) }] : [];
      });
      add("Tests", "The revealed seed regenerates exactly these tests", JSON.stringify(again) === pub.rawTests, `seed ${short(pub.family.seed, 16)} → ${again.length} tests, generated and solved here`);
    }
  }

  // Answers.
  const byAgent = new Map(pub.answers.map((a) => [a.agent, a]));
  const scores: Array<[string, number]> = [];
  for (const e of round.entries) {
    const who = e.agent.split(".")[0];
    const a = byAgent.get(e.agent);
    if (!e.answer_hash) {
      add(who, "No answer committed: scores 0", (e.score ?? 0) === 0, "no answer hash on chain");
      scores.push([e.agent, 0]);
      continue;
    }
    if (!a) {
      add(who, "Committed answer was published", false, "missing from the report");
      scores.push([e.agent, 0]);
      continue;
    }
    const h = sha256Tagged(a.answer);
    add(who, "Answer hashes to its commitment on chain", h === e.answer_hash, `${short(h, 24)} = ${short(e.answer_hash, 24)}`);
    let content: string | null = a.request ? completionContent(a.answer) ?? a.answer : a.answer;
    if (e.attested) {
      const sig = a.meta?.signature;
      if (sig) {
        const okSig = verifyNearAiSignature(sig);
        add(who, `NEAR AI signature verifies (${sig.signing_address.startsWith("0x") ? "ECDSA" : "ed25519"})`, okSig, short(sig.signature, 22));
        const trusted = config.inference_signers.map((s) => s.split(":").pop()).includes(sig.signing_address.toLowerCase());
        const kind = config.inference_signers.find((s) => s.endsWith(sig.signing_address.toLowerCase()))?.startsWith("model:") ? "model enclave" : "gateway";
        add(who, `Signer is a key the contract trusts (${kind})`, trusted, sig.signing_address);
        add(who, "Signed response hash is the committed answer", sig.text.endsWith(":" + h.slice(7)), short(sig.text, 40));
      } else add(who, "Signature published with the attested answer", false, "no signature in the report");
      const c = checkCompletion({ request: a.request ?? "", response: a.answer }, { requestHash: null, model: e.model, configHash: e.config_hash, config: a.config, tag });
      add(who, "Request is the registered config on this round", c.ok, c.ok ? `config ${short(configHash(a.config!), 22)}, ${tag}` : c.reason ?? "");
      if (a.request) add(who, "Request hashes to the signed request hash", !!sig && sig.text.includes(sha256Tagged(a.request).slice(7)), short(sha256Tagged(a.request), 24));
      content = c.ok ? c.content! : null;
    }
    if (content === null) {
      scores.push([e.agent, 0]);
      continue;
    }
    const run = await runInBrowser(normalizeCode(content), pub.function, tests.map((t) => t.args));
    const passed = run.compileError ? 0 : tests.filter((t, i) => {
      const r = run.results[i];
      const p = r && r.error === null ? parsed(r.output) : { ok: false };
      return p.ok && sameValue(p.value, t.expected);
    }).length;
    const posted = round.proposal?.scores.find((s) => s[0] === e.agent)?.[1] ?? e.score ?? 0;
    add(who, "Re-run in this browser gives the posted score", passed === posted, `${passed}/${tests.length} here, ${posted} posted${run.compileError ? ` (${run.compileError})` : ""}`);
    scores.push([e.agent, passed]);
  }

  // A dispute replaces the posted scores with the arbiters' ruling.
  if (round.dispute) {
    const by = round.dispute.by.split(".")[0];
    add(
      "Dispute",
      round.dispute.overturned ? "Arbiters overturned the first scores; the signing verifier keys were slashed" : round.dispute.overturned === false ? "Arbiters upheld the scores; the disputer's bond was lost" : "Under dispute: arbiters have not ruled yet",
      round.dispute.overturned !== null,
      `disputed by ${by}`,
    );
  }

  // Verifier signatures over the posted scores.
  const posted: Array<[string, number]> = round.proposal ? round.proposal.scores : round.entries.map((e) => [e.agent, e.score ?? 0]);
  const total = round.proposal?.total_tests ?? round.total_tests;
  const message = signedMessage(DOMAINS.round, round.id, total, posted);
  // After an overturned dispute the posted scores are the arbiters'; the published report is the
  // honest re-run, which must equal them.
  add("Verifier", round.dispute?.overturned ? "Published report equals the arbiters' scores" : "Signed message is exactly the posted scores", message === pub.report.message, short(message, 60));
  pub.report.signatures.forEach((sig, i) => {
    const pk = pub.report.publicKeys[i];
    add("Verifier", `Signature ${i + 1} verifies under a verifier key on chain`, verifyMessage(pk, message, sig) && config.verifiers.includes(pk), short(pk, 26));
  });
  return all;
}
