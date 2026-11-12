import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  checkCompletion,
  configHash,
  DOMAINS,
  generateKeyPair,
  listTaskIds,
  loadTask,
  publicView,
  roundTag,
  settlementMessage,
  sha256Tagged,
  signedMessage,
  taskPrompt,
  verifyMessage,
  type PublicConfig,
} from "@agent-league/shared";
import { createServer, normalizeCode, recheck, runTests, scoreAnswers, Verifier } from "../src/index.js";

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
  const b = v.submit(1, "b.testnet", "parse-duration", "```js\n" + weak + "\n```");
  v.submit(1, "c.testnet", "parse-duration", good);

  const report = await v.score(1, "parse-duration", [
    { agent: "a.testnet", answer_hash: a.answerHash },
    { agent: "b.testnet", answer_hash: b.answerHash },
    { agent: "c.testnet", answer_hash: "sha256:different" },
    { agent: "d.testnet", answer_hash: null },
  ]);
  assert.equal(report.totalTests, task.tests.length);
  assert.equal(report.scores[0][1], task.tests.length);
  assert.ok(report.scores[1][1] > 0 && report.scores[1][1] < task.tests.length);
  assert.equal(report.scores[2][1], 0, "hash mismatch scores 0");
  assert.match(report.details[2].check ?? "", /does not match the hash/);
  assert.equal(report.scores[3][1], 0, "missing answer scores 0");
  assert.equal(report.message, settlementMessage(1, task.tests.length, report.scores));
  report.signatures.forEach((sig, i) => assert.ok(verifyMessage(keys[i].publicKey, report.message, sig)));
  assert.throws(() => v.submit(1, "e.testnet", "parse-duration", good), /already scored/);
  // The published report lets anyone re-run: same scores from the same inputs.
  const pub = v.published(1)!;
  assert.equal(sha256Tagged(pub.rawTests), report.testsHash);
  const again = await scoreAnswers(pub.function, JSON.parse(pub.rawTests), [
    { agent: "a.testnet", answer_hash: a.answerHash },
    { agent: "b.testnet", answer_hash: b.answerHash },
  ], new Map(pub.answers.map((x) => [x.agent, x])), roundTag("round", 1));
  assert.deepEqual(again.map((d) => d.score), report.scores.slice(0, 2).map((s) => s[1]));
});

// ----- attested completions -----

const config: PublicConfig = { name: "Atlas", model: "deepseek/deepseek-v4.1-flash", systemPrompt: "You write JavaScript.", tools: [] };
const hex = (s: string) => sha256Tagged(s).slice("sha256:".length);

function completion(roundId: number, code: string, cfg = config) {
  const task = publicView(loadTask("parse-duration"));
  const request = JSON.stringify({
    model: cfg.model,
    messages: [
      { role: "system", content: cfg.systemPrompt },
      { role: "user", content: taskPrompt(task, roundTag("round", roundId)) },
    ],
    max_tokens: 32000,
  });
  const response = JSON.stringify({ id: "gen-1", choices: [{ message: { role: "assistant", content: "```js\n" + code + "\n```" } }] });
  return { request, response };
}

test("attested completion is scored from the signed response", async () => {
  const v = new Verifier([generateKeyPair().secretKey]);
  const good = fs.readFileSync(loadTask("parse-duration").referencePath, "utf8");
  const c = completion(7, good);
  const stored = v.submit(7, "a.testnet", "parse-duration", c.response, {}, { request: c.request, config });
  const entry = { agent: "a.testnet", answer_hash: stored.answerHash, attested: true, request_hash: hex(c.request), config_hash: configHash(config) };
  const r = await v.score(7, "parse-duration", [entry]);
  assert.equal(r.scores[0][1], r.totalTests);
});

test("attested completion must match config, round and request hash", () => {
  const c = completion(7, "function parseDuration() {}");
  const base = { requestHash: hex(c.request), configHash: configHash(config), config, tag: roundTag("round", 7) };
  assert.equal(checkCompletion(c, base).ok, true);
  assert.match(checkCompletion(c, { ...base, tag: roundTag("round", 8) }).reason!, /does not name/);
  assert.match(checkCompletion(c, { ...base, requestHash: hex("other") }).reason!, /signed request hash/);
  const other = { ...config, systemPrompt: "Something else." };
  assert.match(checkCompletion(c, { ...base, config: other }).reason!, /config hash/);
  assert.match(checkCompletion(c, { ...base, configHash: configHash(other), config: other }).reason!, /system prompt/);
  assert.match(checkCompletion(c, { ...base, model: "openai/gpt-6-luna" }).reason!, /signed model/);
  assert.match(checkCompletion(c, { ...base, config: undefined }).reason!, /did not publish/);
});

test("job scores are signed under the job domain", async () => {
  const key = generateKeyPair();
  const v = new Verifier([key.secretKey]);
  const good = fs.readFileSync(loadTask("parse-duration").referencePath, "utf8");
  const s = v.submit(3, "a.testnet", "parse-duration", good, {}, { kind: "job" });
  const r = await v.scoreJob(3, "parse-duration", { agent: "a.testnet", answer_hash: s.answerHash });
  assert.equal(r.message, signedMessage(DOMAINS.job, 3, r.totalTests, [["a.testnet", r.totalTests]]));
  assert.ok(verifyMessage(key.publicKey, r.message, r.signatures[0]));
  assert.equal(v.getReport(3), undefined, "jobs and rounds are kept apart");
});

test("watcher re-run agrees with honest scores and catches a lie", async () => {
  const v = new Verifier([generateKeyPair().secretKey]);
  const task = loadTask("parse-duration");
  const good = fs.readFileSync(task.referencePath, "utf8");
  const a = v.submit(5, "a.testnet", "parse-duration", good);
  const b = v.submit(5, "b.testnet", "parse-duration", "function parseDuration() { return null; }");
  const entries = [
    { agent: "a.testnet", answer_hash: a.answerHash },
    { agent: "b.testnet", answer_hash: b.answerHash },
  ];
  const r = await v.score(5, "parse-duration", entries);
  const honest = { id: 5, tests_hash: task.testsHash, entries, proposal: { total_tests: r.totalTests, scores: r.scores } };
  assert.equal((await recheck(v.published(5)!, honest)).ok, true);
  const lie = { ...honest, proposal: { total_tests: r.totalTests, scores: [["a.testnet", 0], ["b.testnet", r.totalTests]] as Array<[string, number]> } };
  const caught = await recheck(v.published(5)!, lie);
  assert.equal(caught.ok, false);
  assert.equal(caught.problems.length, 2);
  const swapped = await recheck(v.published(5)!, { ...honest, tests_hash: "sha256:other" });
  assert.match(swapped.problems[0], /tests hash/);
});

test("open entry: the server accepts an answer only if it matches the commitment on chain", async () => {
  const v = new Verifier([generateKeyPair().secretKey]);
  const answer = "function parseDuration(s) { return null; }";
  const chain = {
    async get(kind: string, id: number) {
      return id === 4 ? { task_ref: "parse-duration", status: "Locked", entries: [{ agent: "ext.testnet", answer_hash: sha256Tagged(answer) }, { agent: "late.testnet", answer_hash: null }] } : null;
    },
  };
  const server = createServer(v, chain).listen(0);
  const port = (server.address() as { port: number }).port;
  const post = (body: unknown) =>
    fetch(`http://localhost:${port}/rounds/4/answers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const t = await fetch(`http://localhost:${port}/rounds/4/task`).then((r) => r.json());
    assert.equal(t.tag, roundTag("round", 4));
    assert.ok(t.prompt.startsWith(t.tag));
    assert.match((await post({ agent: "ext.testnet", answer: answer + " " })).body.error, /does not match/);
    assert.match((await post({ agent: "late.testnet", answer })).body.error, /commit the answer hash/);
    assert.match((await post({ agent: "stranger.testnet", answer })).body.error, /not in this round/);
    const ok = await post({ agent: "ext.testnet", answer });
    assert.equal(ok.status, 200);
    assert.equal(v.getAnswer(4, "ext.testnet")?.answer, answer);
  } finally {
    server.close();
  }
});
