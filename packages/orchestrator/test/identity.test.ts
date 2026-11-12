import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  BODY,
  distinctEnough,
  FACE_SLOTS,
  faceCode,
  MIN_DISTANCE,
  MIN_SHAPE_DISTANCE,
  parseIdentityReply,
  renderFace,
  zeroPrompt,
  type Face,
} from "@agent-league/shared";
import { REPO_ROOT } from "../src/config.js";

const rust = fs.readFileSync(path.join(REPO_ROOT, "contract/src/identity.rs"), "utf8");

test("slot sizes and the uniqueness rule match the contract", () => {
  const slots = /FACE_SLOTS: \[u8; 7\] = \[([^\]]+)\]/.exec(rust)![1].split(",").map((s) => Number(s.trim()));
  assert.deepEqual(FACE_SLOTS, slots);
  assert.equal(Number(/MIN_DISTANCE: u8 = (\d+)/.exec(rust)![1]), MIN_DISTANCE);
  assert.equal(Number(/MIN_SHAPE_DISTANCE: u8 = (\d+)/.exec(rust)![1]), MIN_SHAPE_DISTANCE);
});

test("every face and the body render 13 columns wide", () => {
  for (let h = 0; h < FACE_SLOTS[0]; h++)
    for (let t = 0; t < FACE_SLOTS[1]; t++)
      for (let e = 0; e < FACE_SLOTS[2]; e++)
        for (let a = 0; a < FACE_SLOTS[5]; a++)
          for (const mood of ["idle", "blink", "win", "out"] as const) {
            const lines = renderFace([h, t, e, 0, 0, a, 0], mood);
            assert.equal(lines.length, 6);
            for (const l of lines) assert.equal(l.length, 13, JSON.stringify(l));
          }
  for (let n = 0; n < FACE_SLOTS[3]; n++) for (let m = 0; m < FACE_SLOTS[4]; m++) renderFace([0, 0, 0, n, m, 0, 0]).forEach((l) => assert.equal(l.length, 13));
  BODY.forEach((l) => assert.equal(l.length, 13, JSON.stringify(l)));
});

test("recolors are not distinct, shape changes are", () => {
  const a: Face = [1, 2, 3, 4, 5, 1, 0];
  assert.equal(distinctEnough(a, [1, 2, 3, 4, 5, 1, 7]), false);
  assert.equal(distinctEnough(a, [1, 2, 3, 4, 5, 3, 7]), false);
  assert.equal(distinctEnough(a, [1, 2, 9, 4, 0, 1, 7]), true);
  assert.equal(faceCode([2, 5, 7, 1, 3, 2, 4]), "h2-t5-e7-n1-m3-a2-c4");
});

test("parses a model reply and rejects bad ones", () => {
  const r = parseIdentityReply('Sure!\n{"head":3,"top":2,"eyes":9,"nose":0,"mouth":5,"ears":2,"hue":6,"motto":"Read the spec twice.","why":"Visor for focus."}');
  assert.deepEqual(r.face, [3, 2, 9, 0, 5, 2, 6]);
  assert.equal(r.motto, "Read the spec twice.");
  assert.throws(() => parseIdentityReply('{"head":6,"top":0,"eyes":0,"nose":0,"mouth":0,"ears":0,"hue":0,"motto":"x"}'));
  assert.throws(() => parseIdentityReply('{"head":0,"top":0,"eyes":0,"nose":0,"mouth":0,"ears":0,"hue":0,"motto":""}'));
  assert.ok(zeroPrompt().includes('"lenses"') || zeroPrompt().includes("lenses"));
});
