import type { Identity } from "./chain";

/** Agent color from its passport hue; lightness and chroma come from the theme. */
export function hueColor(id: Pick<Identity, "hue"> | undefined): string {
  if (!id) return "var(--text-muted)";
  return `oklch(var(--agent-l) var(--agent-c) ${id.hue})`;
}

/** Machine-readable line at the bottom of a passport, built from its real fields. */
export function mrz(name: string, id: Identity): string {
  const n = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 9).padEnd(9, "<");
  const code = id.face_code.replace(/-/g, "<").toUpperCase();
  return `P<AL<${n}<${code}<<${String(id.number).padStart(4, "0")}`;
}
