import { test } from "node:test";
import assert from "node:assert/strict";
import { listTaskIds, loadTask, publicView } from "@agent-league/shared";
import { normalizeCode, runTests } from "@agent-league/verifier";
import { ROSTER } from "../src/roster.js";
import { simAnswer } from "../src/sim.js";
import { closestTask, favoriteScout, specialistScout, valueScout } from "../src/scouts.js";

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

test("scripted scouts nominate real agents on curated tryout tasks close to the brief", async () => {
  const tasks = ["eval-expr", "parse-duration", "semver-satisfies", "cron-next"].map((id, i) => {
    const t = publicView(loadTask(id));
    return { id, title: t.title, statement: t.statement, rating: 150_000 + i };
  });
  const field = ROSTER.map((config, i) => ({ agent: `${config.id}.league.testnet`, config, rating: 150_000 + i * 100, rounds: 3, odds: 0 }));
  const brief = { summary: "I need to check which package versions satisfy a semver range like ^1.2.3.", skill: "code.js" };
  assert.equal(closestTask(brief, tasks).id, "semver-satisfies");
  for (const s of [favoriteScout, valueScout, specialistScout]) {
    const picks = await s.nominate!(brief, field, tasks);
    assert.ok(picks.length >= 1);
    for (const p of picks) {
      assert.ok(field.some((f) => f.agent === p.agent), `${s.id}: unknown agent`);
      assert.equal(p.task, "semver-satisfies");
      assert.ok(p.reasoning.length > 10);
    }
  }
  // The favorite nominates the top-rated agent; value the runner-up.
  assert.equal((await favoriteScout.nominate!(brief, field, tasks))[0].agent, field[4].agent);
  assert.equal((await valueScout.nominate!(brief, field, tasks))[0].agent, field[3].agent);
});
