import { useEffect, useState } from "react";
import { BODY, faceGrid, MONITOR_BOTTOM, MONITOR_TOP } from "@benchmarket/shared/identity";
import { paletteStyle } from "./identity";

export type Pose = "idle" | "think" | "win" | "lose" | "out";

/** The shared body with a monitor for a head; the screen shows the agent's 7x7 face. */
export function Figure({ cells, palette, pose, seed = 0, still = false }: { cells: number[]; palette?: number[]; pose: Pose; seed?: number; still?: boolean }) {
  // Occasional flicker, like an old screen.
  const [flicker, setFlicker] = useState(false);
  useEffect(() => {
    if (pose === "out" || still) return;
    let t: ReturnType<typeof setTimeout>;
    const loop = () => {
      setFlicker(true);
      setTimeout(() => setFlicker(false), 110);
      t = setTimeout(loop, 3200 + ((seed * 977) % 2600) + Math.random() * 2500);
    };
    t = setTimeout(loop, 900 + ((seed * 389) % 2200));
    return () => clearTimeout(t);
  }, [pose, seed, still]);

  const grid = faceGrid(cells);
  return (
    <pre className="figure" data-pose={pose} data-flicker={flicker} style={paletteStyle(palette)} aria-hidden="true">
      <span className="bezel">{MONITOR_TOP}</span>
      {"\n"}
      {grid.map((row, r) => (
        <span key={r}>
          <span className="bezel">{" | "}</span>
          <span className="screen">
            {pose === "out"
              ? r === 3
                ? "  NO  SIGNAL  "
                : "              "
              : row.map((v, c) => (
                  <span key={c} className="px" data-v={v} style={{ animationDelay: `${(r * 7 + c) * 30}ms` }}>
                    {v ? "██" : "  "}
                  </span>
                ))}
          </span>
          <span className="bezel">{" | "}</span>
          {"\n"}
        </span>
      ))}
      <span className="bezel">{MONITOR_BOTTOM}</span>
      {"\n"}
      <span className="figure-body">{BODY.join("\n")}</span>
    </pre>
  );
}

/** Square identicon for cards and tables. */
export function Identicon({ cells, palette, size = 60, className }: { cells: number[]; palette?: number[]; size?: number; className?: string }) {
  return (
    <span className={`identicon ${className ?? ""}`} style={{ width: size, height: size, ...paletteStyle(palette) }} aria-hidden="true">
      {faceGrid(cells)
        .flat()
        .map((v, i) => (
          <i key={i} data-v={v} />
        ))}
    </span>
  );
}
