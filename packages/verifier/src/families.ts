import fs from "node:fs";
import { sha256Tagged, type TaskWithTests, type TestCase } from "@benchmarket/shared";
import { runRaw } from "./sandbox.js";

export interface FreshTests {
  seed: string;
  tests: TestCase[];
  /** JSON of `tests`; its hash is what the round commits. */
  raw: string;
  hash: string;
}

/** Tests a family generates per round. */
export const FRESH_TESTS = 24;

/**
 * Fresh hidden tests for a task family: the generator turns the seed into inputs and the
 * reference solution computes the expected outputs, both in the sandbox. Deterministic: anyone
 * with the seed (published with the report) gets the same tests and hash.
 */
export async function generateTests(task: TaskWithTests, seed: string, n = FRESH_TESTS): Promise<FreshTests> {
  if (!task.generator) throw new Error(`${task.id} has no generator`);
  const gen = await runRaw(task.generator, "generate", [[seed, n]], { perTestMs: 5000 });
  const first = gen.results[0];
  if (gen.compileError || !first?.output) throw new Error(`generator of ${task.id} failed: ${gen.compileError ?? first?.error}`);
  const inputs = JSON.parse(first.output) as unknown[][];
  const reference = fs.readFileSync(task.referencePath, "utf8");
  const ref = await runRaw(reference, task.function, inputs);
  const tests: TestCase[] = [];
  inputs.forEach((args, i) => {
    const out = ref.results[i]?.output;
    // Inputs the reference cannot answer cleanly are dropped, deterministically.
    if (typeof out !== "string" || out.includes('"__')) return;
    tests.push({ args, expected: JSON.parse(out) });
  });
  const raw = JSON.stringify(tests);
  return { seed, tests, raw, hash: sha256Tagged(raw) };
}
