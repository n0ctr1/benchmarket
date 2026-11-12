/**
 * Hand-drawn ASCII portraits. `@` marks an eye and `~~~` the mouth; both are swapped per state.
 * Every frame is 8 lines of 15 columns.
 */
const ART: Record<string, string> = {
  atlas: String.raw`
      _|_
   .-[___]-.
   |  @ @  |
   |  ~~~  |
   '-.___.-'
  __/|###|\__
     |###|
    _|_ _|_`,
  bolt: String.raw`
       /
      /_
   .---/---.
  (  @   @  )
  (   ~~~   )
   '-------'
     /|=|\
    / /^\ \ `,
  cipher: String.raw`
    \     /
   .-\---/-.
  | [@] [@] |
  |   ~~~   |
  |_________|
   ][#####][
    |#####|
    d|   |b`,
  delta: String.raw`
       *
      /|\
     / | \
    / @ @ \
   /  ~~~  \
  /_________\
     |/^\|
     d   b`,
  echo: String.raw`
      ___
   .-'   '-.
  /  @   @  \
 ((   ~~~   ))
  \_________/
     _|_|_
    / | | \
     _/ \_`,
};

const SPARE = String.raw`
     .---.
    | @ @ |
    |  ~~~|
    '-----'
     /| |\
    / | | \
     _| |_
`;

export type Mood = "idle" | "blink" | "think" | "think2" | "win" | "lose" | "out";

const EYES: Record<Mood, string> = { idle: "o", blink: "-", think: "°", think2: "·", win: "^", lose: "o", out: "x" };
const MOUTH: Record<Mood, string> = {
  idle: "===",
  blink: "===",
  think: ". .",
  think2: " . ",
  win: String.raw`\_/`,
  lose: "---",
  out: "~~~",
};

export function robotArt(id: string, mood: Mood): string {
  const art = (ART[id] ?? SPARE).replace(/^\n/, "");
  return art
    .split("\n")
    .map((l) => l.replace(/@/g, EYES[mood]).replace("~~~", MOUTH[mood]).padEnd(15))
    .join("\n");
}

/** One-line face for tables. */
export function face(id: string, mood: Mood = "idle"): string {
  const e = EYES[mood];
  const shapes: Record<string, [string, string]> = {
    atlas: ["[", "]"],
    bolt: ["(", ")"],
    cipher: ["|", "|"],
    delta: ["/", "\\"],
    echo: ["((", "))"],
  };
  const [l, r] = shapes[id] ?? ["[", "]"];
  return `${l}${e}_${e}${r}`;
}

/** Agent colors, chosen to stay distinct and readable on both themes. */
const COLORS: Record<string, string> = {
  atlas: "var(--c-atlas)",
  bolt: "var(--c-bolt)",
  cipher: "var(--c-cipher)",
  delta: "var(--c-delta)",
  echo: "var(--c-echo)",
};

export function colorOf(id: string): string {
  return COLORS[id] ?? "var(--text-muted)";
}
