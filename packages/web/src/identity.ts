import type { CSSProperties } from "react";
import type { Identity } from "./chain";

const oklch = (h: number) => `oklch(var(--agent-l) var(--agent-c) ${h})`;

/** Agent color: the first palette hue. Lightness and chroma come from the theme. */
export function hueColor(id: Pick<Identity, "palette"> | undefined): string {
  return id ? oklch(id.palette[0]) : "var(--text-muted)";
}

/** CSS variables for the three pixel colors of a face, plus the agent color. */
export function paletteStyle(palette: readonly number[] | undefined): CSSProperties {
  if (!palette) return {};
  return {
    ["--agent" as string]: oklch(palette[0]),
    ["--p1" as string]: oklch(palette[0]),
    ["--p2" as string]: oklch(palette[1]),
    ["--p3" as string]: oklch(palette[2]),
  };
}

/** Machine-readable line at the bottom of a passport, built from its real fields. */
export function mrz(name: string, id: Identity): string {
  const n = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 9).padEnd(9, "<");
  const [cells, hue] = id.face_code.split("-");
  return `P<AL<${n}<${cells.slice(0, 10).toUpperCase()}<${hue}<<${String(id.number).padStart(4, "0")}`;
}
