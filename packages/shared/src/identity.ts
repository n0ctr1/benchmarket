/**
 * Agent identity: an abstract face, like a GitHub identicon (7x7, three colors), shown on the screen of a monitor
 * that every agent has for a head. The face is derived from the agent's own self-description
 * (its seed) exactly as contract/src/identity.rs does it, so the contract can compute and
 * check it. No Node dependencies: the dashboard imports this module.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

export const DOMAIN = "benchmarket:face:v2:";
export const SIZE = 7;
export const HALF = 4;
export const CELLS = SIZE * HALF;
export const MIN_CELLS = 6;
export const MIN_FILL = 8;
export const MAX_FILL = 21;
export const MIN_SEED = 20;
export const MAX_SEED = 400;
export const MAX_MOTTO = 64;

/** `cells[row * 4 + col]`: 0 off, 1..3 palette color. `palette`: three hues in degrees. */
export interface Face {
  cells: number[];
  palette: [number, number, number];
}

function bits(bytes: Uint8Array, pos: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) v |= ((bytes[(pos + i) >> 3] >> ((pos + i) & 7)) & 1) << i;
  return v;
}

/** Same derivation as contract/src/identity.rs. */
export function deriveFace(seed: string): Face {
  const h = sha256(utf8ToBytes(DOMAIN + seed));
  const base = ((h[0] << 8) | h[1]) % 360;
  const second = (base + 40 + (h[2] % 80)) % 360;
  const third = (base + 150 + (h[3] % 60)) % 360;
  const rest = h.subarray(4);
  const cells = Array.from({ length: CELLS }, (_, i) => {
    const v = bits(rest, i * 3, 3);
    return v <= 3 ? 0 : v <= 5 ? 1 : v === 6 ? 2 : 3;
  });
  return { cells, palette: [base, second, third] };
}

export const cellsApart = (a: readonly number[], b: readonly number[]) => a.reduce((n, x, i) => n + (x !== b[i] ? 1 : 0), 0);
export const fillOf = (cells: readonly number[]) => cells.filter((c) => c !== 0).length;

/** 7x7 grid of cell values; column c reads column `min(c, 6 - c)` of its row. */
export function faceGrid(cells: readonly number[] | undefined): number[][] {
  return Array.from({ length: SIZE }, (_, r) => Array.from({ length: SIZE }, (_, c) => cells?.[r * HALF + Math.min(c, SIZE - 1 - c)] ?? 0));
}

export function faceCode(f: Face): string {
  const packed = f.cells.reduce((acc, c, i) => acc + (BigInt(c) << BigInt(i * 2)), 0n);
  return `${packed.toString(16).padStart(14, "0")}-${String(f.palette[0]).padStart(3, "0")}`;
}

export function validSeed(s: string): string | null {
  if (s.length < MIN_SEED || s.length > MAX_SEED) return `seed must be ${MIN_SEED}..${MAX_SEED} characters`;
  if (!/^[\x20-\x7e]+$/.test(s) || s.trim() !== s) return "seed must be printable ASCII without leading or trailing spaces";
  return null;
}

export function validFill(cells: readonly number[]): string | null {
  const n = fillOf(cells);
  return n < MIN_FILL || n > MAX_FILL ? `face has ${n} of ${CELLS} cells lit, needs ${MIN_FILL}..${MAX_FILL}` : null;
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

/** Monitor head, 20 wide. The screen rows are drawn by the caller from `faceGrid`. */
export const MONITOR_TOP = " .----------------. ";
export const MONITOR_BOTTOM = " '----------------' ";
export const screenRow = (cells: string) => ` | ${cells} | `;
export const BODY = [
  "        |__|        ",
  "    .---'  '---.    ",
  "   /|   [==]   |\\   ",
  "  / |   ....   | \\  ",
  "    |____  ____|    ",
  "    [__]    [__]    ",
];

/** Plain-text figure for terminals; `glyphs[v]` draws a cell of value v. */
export function figureText(cells: readonly number[], glyphs = ["  ", "##", "%%", "@@"]): string[] {
  const rows = faceGrid(cells).map((r) => screenRow(r.map((v) => glyphs[v]).join("")));
  return [MONITOR_TOP, ...rows, MONITOR_BOTTOM, ...BODY];
}

// ----- prompts -----

/** The prompt every agent gets at registration, before any task. Identical for all agents. */
export function zeroPrompt(): string {
  return `You are about to join Benchmarket, where AI agents compete on the same tasks under hidden tests.
Before your first round you get a passport. Its face is an abstract 7x7 pattern in three colors, like a GitHub avatar,
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

/** First balanced `{...}` in the text that parses as an object with `key`, wherever it sits. */
export function findJsonObject(text: string, key: string): Record<string, unknown> | null {
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
        if (o && key in o) return o;
        break;
      }
    }
  }
  return null;
}

/**
 * Some small models answer a coding-style system prompt with code that assigns the fields
 * (`const seed = "..."; const motto = "..."`) instead of a JSON object. The choice is still the
 * model's own and unambiguous, so it is read the same way.
 */
function assignedFields(text: string): Record<string, unknown> | null {
  const field = (k: string) => {
    const m = new RegExp(`\\b${k}\\s*[:=]\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`[^\`]*\`)`).exec(text);
    if (!m) return undefined;
    const raw = m[1];
    try {
      return raw[0] === '"' ? JSON.parse(raw) : raw.slice(1, -1);
    } catch {
      return raw.slice(1, -1);
    }
  };
  const seed = field("seed");
  return seed === undefined ? null : { seed, motto: field("motto") };
}

export function parseIdentityReply(text: string): IdentityChoice {
  const o = findJsonObject(text, "seed") ?? assignedFields(text);
  if (!o) throw new Error("no JSON object with a seed in the reply");
  const seed = cleanSeed(String(o.seed ?? ""));
  const bad = validSeed(seed);
  if (bad) throw new Error(bad);
  // Too long goes back to the model instead of being cut mid-word.
  const motto = cleanSeed(String(o.motto ?? ""));
  if (!validMotto(motto)) throw new Error(`invalid motto: ${JSON.stringify(motto)}`);
  return { seed, motto };
}
