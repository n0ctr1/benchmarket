import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { generateKeyPair, listTaskIds, loadTask, settlementMessage, verifyMessage } from "@agent-league/shared";
import { normalizeCode, runTests, Verifier } from "../src/index.js";

const tests = [
  { args: [2, 3], expected: 5 },
  { args: [0, 0], expected: 0 },
];

test("every reference solution passes all hidden tests", async () => {
  for (const id of listTaskIds()) {
    const task = loadTask(id);
    const code = fs.readFileSync(task.referencePath, "utf8");
    const r = await runTests(code, task.function, task.tests);
    assert.equal(r.compileError, null, `${id}: ${r.compileError}`);
    assert.equal(r.passed, r.total, `${id}: ${r.results.filter((x) => !x.pass).map((x) => x.output ?? x.error).join("; ")}`);
  }
});

test("arrow functions and export keywords work", async () => {
  const r = await runTests(normalizeCode("```js\nexport const add = (a, b) => a + b;\n```"), "add", tests);
  assert.equal(r.passed, 2);
});

test("infinite loop is cut by the per-test timeout", async () => {
  const code = "function add(a, b) { if (a === 0) { while (true) {} } return a + b; }";
  const r = await runTests(code, "add", tests, { perTestMs: 200 });
  assert.equal(r.passed, 1);
  assert.match(r.results[1].error ?? "", /timed out/i);
});

test("eval and Function are blocked", async () => {
  const r1 = await runTests("function add(a, b) { return eval('a + b'); }", "add", tests);
  assert.equal(r1.passed, 0);
  const r2 = await runTests("function add(a, b) { return new Function('a', 'b', 'return a + b')(a, b); }", "add", tests);
  assert.equal(r2.passed, 0);
});

test("no require, process or fetch inside the sandbox", async () => {
  const probe = `function add(a, b) {
    const seen = [typeof require, typeof process, typeof fetch, typeof globalThis.setTimeout];
    if (seen.some((t) => t !== "undefined")) throw new Error(seen.join(","));
    return a + b;
  }`;
  const r = await runTests(probe, "add", tests);
  assert.equal(r.passed, 2, JSON.stringify(r.results));
});

test("classic vm escape through constructors is blocked", async () => {
  // Function from the context realm is disabled (no code generation from strings). Even if an
    // escape worked, the child process runs with --permission, so fs is denied.
  const code = `function add(a, b) {
    const proc = this.constructor.constructor("return process")();
    return proc.mainModule.require("fs").readFileSync("/etc/hostname", "utf8");
  }`;
  const r = await runTests(code, "add", tests);
  assert.equal(r.passed, 0);
});

test("Infinity and undefined never pass as null", async () => {
  const r = await runTests("function f(x) { return x === 1 ? 1 / 0 : undefined; }", "f", [
    { args: [1], expected: null },
    { args: [2], expected: null },
  ]);
  assert.equal(r.passed, 0);
});

test("syntax error scores zero with a reason", async () => {
  const r = await runTests("function add(a, b) { return a + ; }", "add", tests);
  assert.equal(r.passed, 0);
  assert.ok(r.compileError);
});

test("verifier scores in order, zeroes missing or mismatched answers, and signs", async () => {
  const keys = [generateKeyPair(), generateKeyPair()];
  const v = new Verifier(keys.map((k) => k.secretKey));
  const task = loadTask("parse-duration");
  const good = fs.readFileSync(task.referencePath, "utf8");
  const weak = "function parseDuration(s) { const m = /^(\\d+)s$/.exec(s); return m ? Number(m[1]) : null; }";
  const a = v.submit(1, "a.testnet", "parse-duration", good);
  v.submit(1, "b.testnet", "parse-duration", "```js\n" + weak + "\n```");
  v.submit(1, "c.testnet", "parse-duration", good);

  const report = await v.score(1, "parse-duration", ["a.testnet", "b.testnet", "c.testnet", "d.testnet"], {
    "a.testnet": a.answerHash,
    "b.testnet": v.getAnswer(1, "b.testnet")!.answerHash,
    "c.testnet": "sha256:different",
    "d.testnet": null,
  });
  assert.equal(report.totalTests, task.tests.length);
  assert.equal(report.scores[0][1], task.tests.length);
  assert.ok(report.scores[1][1] > 0 && report.scores[1][1] < task.tests.length);
  assert.equal(report.scores[2][1], 0, "hash mismatch scores 0");
  assert.equal(report.scores[3][1], 0, "missing answer scores 0");
  assert.equal(report.message, settlementMessage(1, task.tests.length, report.scores));
  report.signatures.forEach((sig, i) => assert.ok(verifyMessage(keys[i].publicKey, report.message, sig)));
  assert.throws(() => v.submit(1, "e.testnet", "parse-duration", good), /already scored/);
});
