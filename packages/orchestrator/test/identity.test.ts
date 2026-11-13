import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { findJsonObject, CELLS, cellsApart, cleanSeed, deriveFace, DOMAIN, faceCode, faceGrid, figureText, MIN_CELLS, parseIdentityReply, validFill, validSeed } from "@benchmarket/shared";
import { REPO_ROOT } from "../src/config.js";

const rust = fs.readFileSync(path.join(REPO_ROOT, "contract/src/identity.rs"), "utf8");

test("derivation matches the contract's test vector", () => {
  const seed = /VECTOR_SEED: &str = "([^"]+)"/.exec(rust)![1];
  const code = /VECTOR_CODE: &str = "([^"]+)"/.exec(rust)![1];
  const f = deriveFace(seed);
  assert.equal(`${faceCode(f)}/${f.palette[1]}/${f.palette[2]}`, code);
  assert.equal(Number(/MIN_CELLS: u32 = (\d+)/.exec(rust)![1]), MIN_CELLS);
  assert.ok(rust.includes(`DOMAIN: &str = "${DOMAIN}"`));
});

test("grid is mirrored 7x7 and the figure is 20 wide", () => {
  for (const s of ["one seed of words here", "another seed, longer and different", "x".repeat(30)]) {
    const f = deriveFace(s);
    assert.equal(f.cells.length, CELLS);
    const g = faceGrid(f.cells);
    assert.equal(g.length, 7);
    for (const row of g) assert.deepEqual(row, [...row].reverse());
    for (const l of figureText(f.cells)) assert.equal(l.length, 20, JSON.stringify(l));
    assert.ok(f.palette.every((h) => h >= 0 && h < 360));
  }
  assert.equal(cellsApart([0, 1, 2, 3], [0, 1, 3, 0]), 2);
  assert.equal(faceCode({ cells: [1, 2, 3], palette: [7, 0, 0] }), "00000000000039-007");
});

test("seed cleaning and validation", () => {
  assert.equal(cleanSeed("  I’m careful — I read\n the spec.  "), "I'm careful - I read the spec.");
  assert.equal(validSeed("short"), "seed must be 20..400 characters");
  assert.equal(validSeed("A perfectly fine seed of words."), null);
  assert.ok(validFill(Array(7).fill(1)));
  assert.equal(validFill(Array(8).fill(2)), null);
  const r = parseIdentityReply('ok {"seed": "I am a careful agent that reads specs.", "motto": "Edges first."}');
  assert.equal(r.motto, "Edges first.");
  assert.throws(() => parseIdentityReply('{"seed": "tiny", "motto": "x"}'));
  // A model told to answer in code wraps the object in a function.
  const wrapped = '```js\nfunction passport() {\n  return {\n    "seed": "I solve problems {carefully} and check details.",\n    "motto": "Think first."\n  };\n}\n```';
  assert.equal(parseIdentityReply(wrapped).seed, "I solve problems {carefully} and check details.");
  const bare = 'function passport() {\n  return {\n    seed: "I am an assistant that checks details first.",\n    motto: "Think clearly; build carefully.",\n  };\n}';
  assert.equal(parseIdentityReply(bare).motto, "Think clearly; build carefully.");
});

test("finds the scout's JSON after prose with braces", () => {
  const reply = 'Odds {roughly even}. **Echo** is strong.\n\n```json\n{"agent": "delta", "reasoning": "Cheap at 11%."}\n```';
  assert.deepEqual(findJsonObject(reply, "agent"), { agent: "delta", reasoning: "Cheap at 11%." });
  assert.equal(findJsonObject("no json here", "agent"), null);
});
