import { test } from "node:test";
import assert from "node:assert/strict";
import { listTaskIds, loadTask, publicView } from "@agent-league/shared";
import { normalizeCode, runTests } from "@agent-league/verifier";
import { ROSTER } from "../src/roster.js";
import { simAnswer } from "../src/sim.js";
import { favoriteScout, specialistScout, valueScout } from "../src/scouts.js";

test("sim answers are real code with agent-specific scores", async () => {
  for (const id of listTaskIds()) {
    const task = loadTask(id);
    const scores: number[] = [];
    for (const a of ROSTER) {
      const r = await runTests(normalizeCode(simAnswer(a, task, "round-1")), task.function, task.tests);
      assert.equal(r.compileError, null, `${a.id}/${id}: ${r.compileError}`);
      scores.push(r.passed);
    }
    assert.ok(Math.max(...scores) > 0, `${id}: nobody scores`);
    assert.ok(new Set(scores).size > 1, `${id}: all agents tie at ${scores[0]}`);
  }
});

test("sim answers are deterministic per salt and differ across salts", () => {
  const task = loadTask("parse-csv");
  assert.equal(simAnswer(ROSTER[0], task, "x"), simAnswer(ROSTER[0], task, "x"));
  assert.notEqual(simAnswer(ROSTER[0], task, "x"), simAnswer(ROSTER[0], task, "y"));
});

test("scripted scouts pick sensibly", async () => {
  const task = publicView(loadTask("cron-next"));
  const field = ROSTER.map((config, i) => ({
    agent: `${config.id}.league.testnet`,
    config,
    rating: 150_000 + (i === 3 ? 4_000 : 0),
    rounds: 1,
    odds: i === 0 ? 0.6 : 0.1,
  }));
  assert.equal((await favoriteScout.decide(task, field)).agent, "delta.league.testnet");
  // Highest rating relative to price: delta (rated above others, priced at 10%).
  assert.equal((await valueScout.decide(task, field)).agent, "delta.league.testnet");
  // cron-next strengths: cipher and delta, both at 10%: alphabetical tie-break.
  assert.equal((await specialistScout.decide(task, field)).agent, "cipher.league.testnet");
});
