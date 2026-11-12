import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { cleanSeed, deriveFace, faceCode, faceGrid, figureText, MIN_BITS, parseIdentityReply, popcount, validFill, validSeed } from "@agent-league/shared";
import { REPO_ROOT } from "../src/config.js";

const rust = fs.readFileSync(path.join(REPO_ROOT, "contract/src/identity.rs"), "utf8");

test("derivation matches the contract's test vector", () => {
  const f = deriveFace("I read the spec twice and test the edges first.");
  const [p, h] = /EXPECTED_VECTOR: \(u16, u16\) = \((\d+), (\d+)\)/.exec(rust)!.slice(1).map(Number);
  assert.deepEqual(f, { pattern: p, hue: h });
  assert.equal(Number(/MIN_BITS: u32 = (\d+)/.exec(rust)![1]), MIN_BITS);
  assert.ok(rust.includes(`DOMAIN: &str = "agent-league:face:v1:"`));
});

test("grid is mirrored and the figure is 16 wide", () => {
  for (const pattern of [0, 0x7fff, 0x5471, 12345]) {
    const g = faceGrid(pattern);
    for (const row of g) assert.deepEqual(row, [...row].reverse());
    assert.equal(g.flat().filter(Boolean).length, [0, 1, 2, 3, 4].reduce((n, r) => n + [0, 1, 2].reduce((m, c) => m + ((pattern >> (r * 3 + c)) & 1) * (c === 2 ? 1 : 2), 0), 0));
    for (const l of figureText(pattern)) assert.equal(l.length, 16, JSON.stringify(l));
  }
  assert.equal(popcount(0b1011), 3);
  assert.equal(faceCode({ pattern: 0x5a3c, hue: 7 }), "5a3c-007");
});

test("seed cleaning and validation", () => {
  assert.equal(cleanSeed("  I’m careful — I read\n the spec.  "), "I'm careful - I read the spec.");
  assert.equal(validSeed("short"), "seed must be 20..400 characters");
  assert.equal(validSeed("A perfectly fine seed of words."), null);
  assert.ok(validFill(0b111));
  assert.equal(validFill(0b1111), null);
  const r = parseIdentityReply('ok {"seed": "I am a careful agent that reads specs.", "motto": "Edges first."}');
  assert.equal(r.motto, "Edges first.");
  assert.throws(() => parseIdentityReply('{"seed": "tiny", "motto": "x"}'));
  // A model told to answer in code wraps the object in a function.
  const wrapped = '```js\nfunction passport() {\n  return {\n    "seed": "I solve problems {carefully} and check details.",\n    "motto": "Think first."\n  };\n}\n```';
  assert.equal(parseIdentityReply(wrapped).seed, "I solve problems {carefully} and check details.");
  const bare = 'function passport() {\n  return {\n    seed: "I am an assistant that checks details first.",\n    motto: "Think clearly; build carefully.",\n  };\n}';
  assert.equal(parseIdentityReply(bare).motto, "Think clearly; build carefully.");
});
