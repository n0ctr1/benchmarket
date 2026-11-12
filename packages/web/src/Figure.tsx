import { useEffect, useState } from "react";
import { BODY, faceGrid, MONITOR_BOTTOM, MONITOR_TOP } from "@agent-league/shared/identity";

export type Pose = "idle" | "think" | "win" | "lose" | "out";

/** The shared body with a monitor for a head; the screen shows the agent's identicon. */
export function Figure({ pattern, pose, seed = 0 }: { pattern: number; pose: Pose; seed?: number }) {
  // Occasional flicker, like an old screen.
  const [flicker, setFlicker] = useState(false);
  useEffect(() => {
    if (pose === "out") return;
    let t: ReturnType<typeof setTimeout>;
    const loop = () => {
      setFlicker(true);
      setTimeout(() => setFlicker(false), 110);
      t = setTimeout(loop, 3200 + ((seed * 977) % 2600) + Math.random() * 2500);
    };
    t = setTimeout(loop, 900 + ((seed * 389) % 2200));
    return () => clearTimeout(t);
  }, [pose, seed]);

  const grid = faceGrid(pattern);
  return (
    <pre className="figure" data-pose={pose} data-flicker={flicker} aria-hidden="true">
      <span className="bezel">{MONITOR_TOP}</span>
      {"\n"}
      {grid.map((row, r) => (
        <span key={r}>
          <span className="bezel">{" | "}</span>
          <span className="screen">
            {pose === "out"
              ? r === 2
                ? "NO  SIGNAL"
                : "          "
              : row.map((on, c) => (
                  <span key={c} className={on ? "px on" : "px"} style={{ animationDelay: `${(r * 5 + c) * 40}ms` }}>
                    {on ? "██" : "  "}
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
export function Identicon({ pattern, size = 60, className }: { pattern: number; size?: number; className?: string }) {
  const grid = faceGrid(pattern);
  return (
    <span className={`identicon ${className ?? ""}`} style={{ width: size, height: size }} aria-hidden="true">
      {grid.flat().map((on, i) => (
        <i key={i} data-on={on} />
      ))}
    </span>
  );
}
