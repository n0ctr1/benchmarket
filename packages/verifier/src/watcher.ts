import { roundTag, sha256Tagged, type TestCase } from "@benchmarket/shared";
import { runRaw } from "./sandbox.js";
import { scoreAnswers, type ChainEntry, type Kind, type PublishedReport } from "./verifier.js";

/** What a watcher reads from the chain about a round (or a job, as a one-entry round). */
export interface ChainRoundLike {
  id: number;
  tests_hash: string;
  entries: ChainEntry[];
  proposal: { total_tests: number; scores: Array<[string, number]> } | null;
}

export interface Recheck {
  ok: boolean;
  problems: string[];
  /** Scores the watcher computed itself, in entry order. */
  scores: Array<[string, number]>;
  totalTests: number;
}

/**
 * Re-runs a published report independently: the tests must hash to the commitment on chain,
 * every answer to its committed hash, and the re-computed scores must equal the posted ones.
 * Any mismatch is grounds for a dispute.
 */
export async function recheck(p: PublishedReport, round: ChainRoundLike, kind: Kind = "round"): Promise<Recheck> {
  const problems: string[] = [];
  if (sha256Tagged(p.rawTests) !== round.tests_hash) problems.push("published tests do not match the tests hash on chain");
  const tests = JSON.parse(p.rawTests) as TestCase[];
  // Fresh tests must be exactly what the family's generator and reference make of the seed.
  if (p.family) {
    if ("family:" + sha256Tagged(p.family.generator + "\n" + p.family.reference) !== p.family.familyHash) problems.push("published generator does not match its family hash");
    const again = await regenerate(p.family.generator, p.family.reference, p.function, p.family.seed, p.family.count);
    if (again !== p.rawTests) problems.push("the seed does not regenerate the published tests");
  }
  const answers = new Map(p.answers.map((a) => [a.agent, a]));
  for (const a of p.answers) {
    if (sha256Tagged(a.answer) !== a.answerHash) problems.push(`answer of ${a.agent} does not hash to its stated hash`);
  }
  const details = await scoreAnswers(p.function, tests, round.entries, answers, roundTag(kind, round.id));
  const scores: Array<[string, number]> = details.map((d) => [d.agent, d.score]);
  const posted = round.proposal;
  if (!posted) problems.push("no scores posted on chain");
  else {
    if (posted.total_tests !== tests.length) problems.push(`posted total ${posted.total_tests}, tests have ${tests.length}`);
    scores.forEach(([agent, s], i) => {
      const got = posted.scores[i];
      if (!got || got[0] !== agent || got[1] !== s) problems.push(`${agent}: posted ${got?.[1] ?? "nothing"}, re-run gives ${s}`);
    });
  }
  return { ok: problems.length === 0, problems, scores, totalTests: tests.length };
}

/** The same generation as `generateTests`, from published sources instead of the task folder. */
async function regenerate(generator: string, reference: string, fn: string, seed: string, count: number): Promise<string> {
  const gen = await runRaw(generator, "generate", [[seed, count]], { perTestMs: 5000 });
  const inputs = JSON.parse(gen.results[0]?.output ?? "[]") as unknown[][];
  const ref = await runRaw(reference, fn, inputs);
  const tests: TestCase[] = [];
  inputs.forEach((args, i) => {
    const out = ref.results[i]?.output;
    if (typeof out === "string" && !out.includes('"__')) tests.push({ args, expected: JSON.parse(out) });
  });
  return JSON.stringify(tests);
}
