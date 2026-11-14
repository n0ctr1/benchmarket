#!/usr/bin/env node
// README smoke test: runs the "Screening in 60 seconds" commands exactly as written, in a clean
// shell (no profile, no environment but PATH), and compares their output with the expected block
// below them. Then checks that every relative link in the docs points at a file that exists,
// that every in-page anchor in README.md names a heading, and that the hosted site answers.
//
//   npm run smoke:readme            everything
//   npm run smoke:readme -- --links links only (no network)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const linksOnly = process.argv.includes("--links");
const failures = [];

/** The first fenced block after an HTML comment marker. */
function blockAfter(marker) {
  const at = README.indexOf(`<!-- ${marker} -->`);
  if (at < 0) throw new Error(`README.md has no <!-- ${marker} --> marker`);
  const m = /```[a-z]*\n([\s\S]*?)\n```/.exec(README.slice(at));
  if (!m) throw new Error(`no fenced block after ${marker}`);
  return m[1];
}

// ----- the screening commands -----

if (!linksOnly) {
  const commands = blockAfter("screening:commands");
  const expected = blockAfter("screening:expected").trim().split("\n").map((l) => l.trim());
  let lines = [];
  // Public RPCs rate-limit: a failed run is retried a few times before it counts.
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = spawnSync("bash", ["--noprofile", "--norc", "-c", commands], {
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 90_000,
    });
    lines = (r.stdout ?? "").trim().split("\n").map((l) => l.trim());
    if (r.status === 0 && lines.length === expected.length && lines.every((l, i) => l === expected[i])) break;
    if (attempt < 4) {
      console.log(`screening run ${attempt} did not match, retrying${r.stderr ? `: ${r.stderr.trim().split("\n").pop()}` : ""}`);
      spawnSync("sleep", [String(5 * attempt)]);
    }
  }
  expected.forEach((want, i) => {
    const got = lines[i] ?? "(no output)";
    if (got === want) console.log(`ok   ${want}`);
    else failures.push(`screening line ${i + 1}\n  expected: ${want}\n  got:      ${got}`);
  });
}

// ----- links -----

const slug = (h) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]/g, "")
    .replace(/ /g, "-");
const anchors = new Set([...README.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1].replace(/`/g, ""))));

for (const doc of ["README.md", "RULES.md", "evidence/README.md", "docs/history/IDEA.md", "docs/run.md", "SECURITY.md"]) {
  const file = path.join(ROOT, doc);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1];
    if (/^(https?:|mailto:)/.test(href)) continue;
    if (href.startsWith("#")) {
      if (doc === "README.md" && !anchors.has(href.slice(1))) failures.push(`${doc}: no heading for ${href}`);
      continue;
    }
    const target = path.resolve(path.dirname(file), href.split("#")[0]);
    if (!fs.existsSync(target)) failures.push(`${doc}: broken link ${href}`);
  }
}
console.log("ok   relative links and README anchors checked");

// ----- the hosted site -----

if (!linksOnly) {
  const site = "https://www.bench-market.xyz/";
  const res = await fetch(site).catch((e) => ({ ok: false, status: String(e) }));
  if (res.ok) console.log(`ok   ${site} answers`);
  else failures.push(`${site} answered ${res.status}`);
}

if (failures.length) {
  console.error(`\n${failures.length} problem(s):\n${failures.map((f) => `- ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("\nREADME smoke test passed");
