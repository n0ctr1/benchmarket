/**
 * Agent identity: an abstract face, like a GitHub identicon, shown on the screen of a monitor
 * that every agent has for a head. The face is derived from the agent's own self-description
 * (its seed) exactly as contract/src/identity.rs does it, so the contract can compute and
 * check it. No Node dependencies: the dashboard imports this module.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

export const DOMAIN = "agent-league:face:v1:";
export const CELLS = 15;
export const MIN_BITS = 3;
export const MIN_FILL = 4;
export const MAX_FILL = 11;
export const MIN_SEED = 20;
export const MAX_SEED = 400;
export const MAX_MOTTO = 64;

export interface Face {
  pattern: number;
  hue: number;
}

export function deriveFace(seed: string): Face {
  const h = sha256(utf8ToBytes(DOMAIN + seed));
  return { pattern: (h[0] | (h[1] << 8)) & 0x7fff, hue: ((h[2] << 8) | h[3]) % 360 };
}

export function popcount(x: number): number {
  let n = 0;
  for (let v = x; v; v &= v - 1) n++;
  return n;
}

export const bitsApart = (a: number, b: number) => popcount(a ^ b);

/** 5x5 grid; column c reads bit `row * 3 + min(c, 4 - c)`, so it is mirrored like GitHub's. */
export function faceGrid(pattern: number): boolean[][] {
  return Array.from({ length: 5 }, (_, r) => Array.from({ length: 5 }, (_, c) => ((pattern >> (r * 3 + Math.min(c, 4 - c))) & 1) === 1));
}

export function faceCode(f: Face): string {
  return `${f.pattern.toString(16).padStart(4, "0")}-${String(f.hue).padStart(3, "0")}`;
}

export function validSeed(s: string): string | null {
  if (s.length < MIN_SEED || s.length > MAX_SEED) return `seed must be ${MIN_SEED}..${MAX_SEED} characters`;
  if (!/^[\x20-\x7e]+$/.test(s) || s.trim() !== s) return "seed must be printable ASCII without leading or trailing spaces";
  return null;
}

export function validFill(pattern: number): string | null {
  const n = popcount(pattern);
  return n < MIN_FILL || n > MAX_FILL ? `pattern has ${n} of ${CELLS} cells filled, needs ${MIN_FILL}..${MAX_FILL}` : null;
}

export function validMotto(m: string): boolean {
  const t = m.trim();
  return t.length > 0 && t.length <= MAX_MOTTO && /^[\x20-\x7e]+$/.test(t);
}

/** Turns model output into a valid seed: ASCII punctuation, single spaces, no edges. */
export function cleanSeed(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7e]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SEED)
    .trim();
}

// ----- the body every agent shares -----

/** Monitor head, 16 wide. The screen rows are drawn by the caller from `faceGrid`. */
export const MONITOR_TOP = " .------------. ";
export const MONITOR_BOTTOM = " '------------' ";
export const screenRow = (cells: string) => ` | ${cells} | `;
export const BODY = [
  "      |__|      ",
  "   .--'  '--.   ",
  "  /|  [==]  |\\  ",
  " / |  ....  | \\ ",
  "   |___  ___|   ",
  "   [__]  [__]   ",
];

/** Plain-text figure for terminals: `##` is a lit cell. */
export function figureText(pattern: number, on = "##", off = "  "): string[] {
  const rows = faceGrid(pattern).map((r) => screenRow(r.map((c) => (c ? on : off)).join("")));
  return [MONITOR_TOP, ...rows, MONITOR_BOTTOM, ...BODY];
}

// ----- prompts -----

/** The prompt every agent gets at registration, before any task. Identical for all agents. */
export function zeroPrompt(): string {
  return `You are about to join Agent League, where AI agents compete on the same tasks under hidden tests.
Before your first round you get a passport. Its face is an abstract 5x5 pattern, like a GitHub avatar,
shown on the screen of the monitor every agent has for a head. The league does not draw it for you:
it hashes your own words. Whatever you write below becomes your face.

Write:
- "seed": a self-description in your own words, 2 or 3 sentences, ${MIN_SEED} to ${MAX_SEED} printable ASCII characters.
  Who you are and how you approach a task. Be specific to yourself.
- "motto": one line, at most ${MAX_MOTTO} printable ASCII characters.

Reply with JSON only: {"seed": "...", "motto": "..."}`;
}

/** Follow-up after a rejected face. */
export function conflictPrompt(reason: string): string {
  return `The league rejected the face your seed produced: ${reason}.
Rewrite your self-description with different words (the meaning can stay). Reply with the same JSON format.`;
}

export interface IdentityChoice {
  seed: string;
  motto: string;
}

/** JSON, or a JavaScript object literal with bare keys (models told to answer in code do that). Never evaluated. */
function parseLoose(src: string): Record<string, unknown> | null {
  for (const candidate of [src, src.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":').replace(/,(\s*})/g, "$1")]) {
    try {
      const o = JSON.parse(candidate);
      if (o && typeof o === "object" && !Array.isArray(o)) return o as Record<string, unknown>;
    } catch {
      // try the next form
    }
  }
  return null;
}

/** First balanced `{...}` in the text that parses as JSON and has a `seed`, wherever it sits. */
function findObject(text: string): Record<string, unknown> | null {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        const o = parseLoose(text.slice(start, i + 1));
        if (o && "seed" in o) return o;
        break;
      }
    }
  }
  return null;
}

export function parseIdentityReply(text: string): IdentityChoice {
  const o = findObject(text);
  if (!o) throw new Error("no JSON object with a seed in the reply");
  const seed = cleanSeed(String(o.seed ?? ""));
  const bad = validSeed(seed);
  if (bad) throw new Error(bad);
  // Too long goes back to the model instead of being cut mid-word.
  const motto = cleanSeed(String(o.motto ?? ""));
  if (!validMotto(motto)) throw new Error(`invalid motto: ${JSON.stringify(motto)}`);
  return { seed, motto };
}
