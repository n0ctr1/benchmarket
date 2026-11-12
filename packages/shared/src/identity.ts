/**
 * Agent identity: a face the agent picks for itself from a fixed grammar of ASCII parts.
 * Slot sizes and the uniqueness rule must match contract/src/identity.rs.
 * This module has no Node dependencies so the dashboard can import it.
 */

export const SLOT_NAMES = ["head", "top", "eyes", "nose", "mouth", "ears", "hue"] as const;
export type SlotName = (typeof SLOT_NAMES)[number];
export type Face = [number, number, number, number, number, number, number];

export const SHAPE_SLOTS = 6;
export const MIN_DISTANCE = 3;
export const MIN_SHAPE_DISTANCE = 2;
export const MAX_MOTTO = 64;

/** [top edge, left side, right side, bottom edge]; edges are 9 wide. */
export const HEADS: Array<{ name: string; top: string; l: string; r: string; bottom: string }> = [
  { name: "box", top: ".-------.", l: "|", r: "|", bottom: "'-------'" },
  { name: "round", top: " .-----. ", l: "(", r: ")", bottom: " '-----' " },
  { name: "plate", top: "+-------+", l: "|", r: "|", bottom: "+-------+" },
  { name: "visor", top: "[=======]", l: "[", r: "]", bottom: "[_______]" },
  { name: "hex", top: " /-----\\ ", l: "<", r: ">", bottom: " \\-----/ " },
  { name: "shield", top: ".-------.", l: "|", r: "|", bottom: " \\_____/ " },
];

/** 13 wide, drawn above the head. */
export const TOPS: Array<{ name: string; art: string }> = [
  { name: "none", art: "             " },
  { name: "pin", art: "      i      " },
  { name: "mast", art: "     _|_     " },
  { name: "horns", art: "    \\   /    " },
  { name: "crown", art: "    /\\/\\/\\   " },
  { name: "waves", art: "    ~~~~~    " },
  { name: "lamp", art: "     (*)     " },
  { name: "fin", art: "     /|\\     " },
];

/** 7 wide, inside the head. */
export const EYES: Array<{ name: string; art: string }> = [
  { name: "dots", art: " o   o " },
  { name: "wide", art: " O   O " },
  { name: "spiral", art: " @   @ " },
  { name: "stars", art: " *   * " },
  { name: "odd", art: " 0   o " },
  { name: "close", art: "  o o  " },
  { name: "curious", art: " q   p " },
  { name: "grid", art: " #   # " },
  { name: "focused", art: " >   < " },
  { name: "lenses", art: "[o] [o]" },
];

export const NOSES: Array<{ name: string; art: string }> = [
  { name: "none", art: "       " },
  { name: "dot", art: "   .   " },
  { name: "peak", art: "   ^   " },
  { name: "bridge", art: "   |   " },
  { name: "beak", art: "   v   " },
  { name: "cheeks", art: " '   ' " },
];

export const MOUTHS: Array<{ name: string; art: string }> = [
  { name: "grille", art: "  ===  " },
  { name: "line", art: "  ---  " },
  { name: "smile", art: "  \\_/  " },
  { name: "flat", art: "  ___  " },
  { name: "wave", art: "  ~~~  " },
  { name: "speaker", art: "  [#]  " },
  { name: "teeth", art: "  vvv  " },
  { name: "grin", art: " \\___/ " },
  { name: "whistle", art: "  -o-  " },
  { name: "vents", art: "  :::  " },
];

/** Left and right ear, 2 wide each, on the eye row. */
export const EARS: Array<{ name: string; l: string; r: string }> = [
  { name: "none", l: "  ", r: "  " },
  { name: "cups", l: " d", r: "b " },
  { name: "bolts", l: "-[", r: "]-" },
  { name: "dishes", l: "((", r: "))" },
  { name: "fins", l: " <", r: "> " },
  { name: "knobs", l: "o-", r: "-o" },
];

/** Hue in degrees; the dashboard picks lightness and chroma per theme. */
export const HUES: Array<{ name: string; deg: number }> = [
  { name: "rose", deg: 5 },
  { name: "coral", deg: 35 },
  { name: "amber", deg: 75 },
  { name: "lime", deg: 120 },
  { name: "green", deg: 150 },
  { name: "teal", deg: 185 },
  { name: "sky", deg: 220 },
  { name: "blue", deg: 255 },
  { name: "violet", deg: 290 },
  { name: "magenta", deg: 330 },
];

export const FACE_SLOTS = [HEADS.length, TOPS.length, EYES.length, NOSES.length, MOUTHS.length, EARS.length, HUES.length];

/** The same seven-line body for every agent, 13 wide. */
export const BODY = [
  "     |=|     ",
  "  .--'-'--.  ",
  " /| [###] |\\ ",
  "/ |  ___  | \\",
  "  |_|   |_|  ",
  "  [_]   [_]  ",
];

export type FaceMood = "idle" | "blink" | "win" | "out" | "think";

/** Six lines, 13 wide. The mood only changes the eye glyphs; the face stays recognizable. */
export function renderFace(face: Face, mood: FaceMood = "idle", tick = 0): string[] {
  const [h, t, e, n, m, a] = face;
  const head = HEADS[h];
  const ear = EARS[a];
  let eyes = EYES[e].art;
  const swap = mood === "blink" ? "-" : mood === "win" ? "^" : mood === "out" ? "x" : mood === "think" ? (tick % 2 ? "." : "'") : null;
  if (swap) eyes = eyes.replace(/[^\s[\]]/g, swap);
  return [
    TOPS[t].art,
    `  ${head.top}  `,
    `${ear.l}${head.l}${eyes}${head.r}${ear.r}`,
    `  ${head.l}${NOSES[n].art}${head.r}  `,
    `  ${head.l}${MOUTHS[m].art}${head.r}  `,
    `  ${head.bottom}  `,
  ];
}

export function validateFace(face: unknown): face is Face {
  return (
    Array.isArray(face) &&
    face.length === FACE_SLOTS.length &&
    face.every((v, i) => Number.isInteger(v) && v >= 0 && v < FACE_SLOTS[i])
  );
}

export function faceDistance(a: readonly number[], b: readonly number[]): { all: number; shape: number } {
  let all = 0;
  let shape = 0;
  for (let i = 0; i < FACE_SLOTS.length; i++) {
    if (a[i] !== b[i]) {
      all++;
      if (i < SHAPE_SLOTS) shape++;
    }
  }
  return { all, shape };
}

export function distinctEnough(a: readonly number[], b: readonly number[]): boolean {
  const d = faceDistance(a, b);
  return d.all >= MIN_DISTANCE && d.shape >= MIN_SHAPE_DISTANCE;
}

export function faceCode(face: readonly number[]): string {
  const tags = ["h", "t", "e", "n", "m", "a", "c"];
  return face.map((v, i) => `${tags[i]}${v}`).join("-");
}

export function validMotto(m: string): boolean {
  const t = m.trim();
  return t.length > 0 && t.length <= MAX_MOTTO && /^[\x20-\x7e]+$/.test(t);
}

/** The prompt every agent gets at registration, before any task. Identical for all agents. */
export function zeroPrompt(): string {
  const list = (title: string, slot: SlotName, items: Array<{ name: string; art?: string; l?: string; r?: string; top?: string; deg?: number }>) =>
    `${title} ("${slot}"):\n` +
    items
      .map((x, i) => {
        const art = x.art ?? (x.top !== undefined ? `${x.top} ... ${(x as { bottom?: string }).bottom}` : x.l !== undefined ? `${x.l}<head>${x.r}` : `${x.deg} deg`);
        return `  ${i}: ${x.name.padEnd(8)} ${JSON.stringify(art)}`;
      })
      .join("\n");
  return `You are about to join Agent League, where AI agents compete on the same tasks under hidden tests.
Before your first round you get a passport: an ASCII face that you choose for yourself, plus a motto.
Pick parts that say something true about how you work. Every agent's body is the same; only the face is yours.

${list("Head shape", "head", HEADS)}

${list("Top of the head", "top", TOPS)}

${list("Eyes", "eyes", EYES)}

${list("Nose", "nose", NOSES)}

${list("Mouth", "mouth", MOUTHS)}

${list("Ears", "ears", EARS)}

${list("Color", "hue", HUES)}

Faces must be unique: yours must differ from every existing agent's face in at least ${MIN_DISTANCE} parts,
and at least ${MIN_SHAPE_DISTANCE} of them must be shape parts (not just the color).

Reply with JSON only:
{"head": <id>, "top": <id>, "eyes": <id>, "nose": <id>, "mouth": <id>, "ears": <id>, "hue": <id>,
 "motto": "<at most ${MAX_MOTTO} printable ASCII characters>", "why": "<one sentence on why this face>"}`;
}

/** Follow-up after a rejected face. */
export function conflictPrompt(taken: Array<{ agent: string; face: readonly number[] }>, rejected: readonly number[], reason: string): string {
  const rows = taken.map((t) => `  ${t.agent}: ${JSON.stringify(Object.fromEntries(SLOT_NAMES.map((s, i) => [s, t.face[i]])))}`).join("\n");
  return `Your face ${JSON.stringify(Object.fromEntries(SLOT_NAMES.map((s, i) => [s, rejected[i]])))} was rejected: ${reason}.
Faces already taken:
${rows}
Choose again. Keep what matters most to you and change the rest. Reply with the same JSON format.`;
}

export interface IdentityChoice {
  face: Face;
  motto: string;
  why: string;
}

export function parseIdentityReply(text: string): IdentityChoice {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) throw new Error("no JSON object in reply");
  const o = JSON.parse(json) as Record<string, unknown>;
  const face = SLOT_NAMES.map((s) => Number(o[s])) as Face;
  if (!validateFace(face)) throw new Error(`face out of range: ${JSON.stringify(face)}`);
  const motto = String(o.motto ?? "").trim();
  if (!validMotto(motto)) throw new Error(`invalid motto: ${JSON.stringify(motto)}`);
  return { face, motto, why: String(o.why ?? "").trim().slice(0, 300) };
}
