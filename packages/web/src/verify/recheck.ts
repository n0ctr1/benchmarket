/**
 * Re-checks a round in the browser from public data only: the contract (over RPC) and the
 * verifier's published report. Every check records what it compared, so a reader sees the values.
 */
import { checkCompletion, completionContent, configHash, roundTag, verifyNearAiSignature, type PublicConfig } from "@benchmarket/shared/inference";
import { sha256Tagged } from "@benchmarket/shared/hash";
import { verifyMessage } from "@benchmarket/shared/keys";
import { signedMessage, DOMAINS } from "@benchmarket/shared/settlement";
import type { Round } from "../chain";
import { runInBrowser } from "./sandbox";

export interface Check {
  group: string;
  label: string;
  ok: boolean;
  detail: string;
  /** Not decidable in a browser (a heap limit a worker cannot enforce); the Node watcher decides it. */
  deferred?: boolean;
}

export interface Published {
  report: { roundId: number; totalTests: number; scores: Array<[string, number]>; message: string; signatures: string[]; publicKeys: string[]; taskId: string; details?: Array<{ agent: string; run?: { compileError?: string | null } }> };
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
    else if (pub.function.startsWith("sql:")) {
      // A SQL family: the browser regenerates the databases from the seed; the expected rows
      // come from the reference query, which the Node watcher runs in SQLite.
      const published = tests.map((t) => JSON.stringify(t.args));
      const same = inputs.length >= published.length && published.every((a) => inputs.some((x) => JSON.stringify(x) === a));
      add("Tests", "The revealed seed regenerates exactly these databases", same, `seed ${short(pub.family.seed, 16)} gives ${inputs.length} databases; expected rows: Node watcher`);
    } else {
      const ref = await runInBrowser(pub.family.reference, pub.function, inputs);
      const again = inputs.flatMap((args, i) => {
        const o = ref.results[i]?.output;
        return typeof o === "string" && !o.includes('"__') ? [{ args, expected: JSON.parse(o) }] : [];
      });
      add("Tests", "The revealed seed regenerates exactly these tests", JSON.stringify(again) === pub.rawTests, `seed ${short(pub.family.seed, 16)} gives ${again.length} tests, generated and solved here`);
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
    if (pub.function.startsWith("sql:")) {
      // SQL answers run in SQLite; this page does not ship it, so the watcher decides the score.
      const posted = round.proposal?.scores.find((s) => s[0] === e.agent)?.[1] ?? e.score ?? 0;
      const c = { group: who, label: "Re-run gives the posted score: decided by the Node watcher", ok: false, deferred: true, detail: `a SQL answer, run in SQLite by npm run league -- watch --round ${round.id} (posted ${posted}/${tests.length})` };
      all.push(c);
      onCheck(c);
      scores.push([e.agent, posted]);
      continue;
    }
    const run = await runInBrowser(normalizeCode(content), pub.function, tests.map((t) => t.args));
    const passed = run.compileError ? 0 : tests.filter((t, i) => {
      const r = run.results[i];
      const p = r && r.error === null ? parsed(r.output) : { ok: false };
      return p.ok && sameValue(p.value, t.expected);
    }).length;
    const posted = round.proposal?.scores.find((s) => s[0] === e.agent)?.[1] ?? e.score ?? 0;
    // The verifier's sandbox caps the heap at 128 MB and scores a run it had to kill 0. A browser
    // worker has no heap cap, so it cannot decide that case: it is shown as deferred (never as a
    // pass) and the Node watcher, which runs the verifier's own sandbox, settles it.
    const killed = pub.report.details?.find((d) => d.agent === e.agent)?.run?.compileError?.startsWith("killed:");
    if (passed !== posted && posted === 0 && killed) {
      const c = { group: who, label: "Re-run gives the posted score: decided by the Node watcher", ok: false, deferred: true, detail: `the verifier's sandbox stopped it at its 128 MB heap limit and scored 0; a browser cannot cap the heap (${passed}/${tests.length} here without one). Run: npm run league -- watch --round ${round.id}` };
      all.push(c);
      onCheck(c);
      scores.push([e.agent, posted]);
      continue;
    }
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
