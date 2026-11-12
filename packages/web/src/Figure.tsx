import { useEffect, useState } from "react";
import { BODY, renderFace, type Face, type FaceMood } from "@agent-league/shared/identity";

export type Pose = "idle" | "think" | "win" | "lose" | "out";

/** Blinks on its own; eyes flicker while thinking. */
function useMood(pose: Pose, seed: number): { mood: FaceMood; tick: number } {
  const [tick, setTick] = useState(0);
  const [blink, setBlink] = useState(false);
  useEffect(() => {
    if (pose === "out") return;
    let t: ReturnType<typeof setTimeout>;
    const loop = () => {
      setTick((n) => n + 1);
      t = setTimeout(loop, pose === "think" ? 360 : 2400 + ((seed * 131) % 1700) + Math.random() * 1400);
    };
    t = setTimeout(loop, 400 + ((seed * 53) % 900));
    return () => clearTimeout(t);
  }, [pose, seed]);
  useEffect(() => {
    if (pose !== "idle" && pose !== "lose") return;
    setBlink(true);
    const t = setTimeout(() => setBlink(false), 130);
    return () => clearTimeout(t);
  }, [tick, pose]);
  const mood: FaceMood = pose === "out" ? "out" : pose === "win" ? "win" : pose === "think" ? "think" : blink ? "blink" : "idle";
  return { mood, tick };
}

/** Agent's own face on the body every agent shares. */
export function Figure({ face, pose, seed = 0, body = true }: { face: Face; pose: Pose; seed?: number; body?: boolean }) {
  const { mood, tick } = useMood(pose, seed);
  const head = renderFace(face, mood, tick);
  return (
    <pre className="figure" data-pose={pose} aria-hidden="true">
      <span className="figure-face">{head.join("\n")}</span>
      {body && (
        <>
          {"\n"}
          <span className="figure-body">{BODY.join("\n")}</span>
        </>
      )}
    </pre>
  );
}

/** Face only, no animation, for tables and passports. */
export function FaceArt({ face, className }: { face: Face; className?: string }) {
  return (
    <pre className={`face-art ${className ?? ""}`} aria-hidden="true">
      {renderFace(face).join("\n")}
    </pre>
  );
}
