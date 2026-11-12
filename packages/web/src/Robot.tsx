import { useEffect, useState } from "react";
import { robotArt, type Mood } from "./robots";

/** ASCII robot that blinks on its own and fidgets while thinking. */
export function Robot({ id, mood }: { id: string; mood: "idle" | "think" | "win" | "lose" | "out" }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (mood === "out") return;
    const period = mood === "think" ? 380 : 2600 + ((id.charCodeAt(0) * 97) % 1900);
    let t: ReturnType<typeof setTimeout>;
    const loop = () => {
      setTick((n) => n + 1);
      t = setTimeout(loop, mood === "think" ? period : period + Math.random() * 1200);
    };
    t = setTimeout(loop, period / 2);
    return () => clearTimeout(t);
  }, [id, mood]);

  const [blinking, setBlinking] = useState(false);
  useEffect(() => {
    if (mood !== "idle" && mood !== "lose") return;
    setBlinking(true);
    const t = setTimeout(() => setBlinking(false), 140);
    return () => clearTimeout(t);
  }, [tick, mood]);

  let frame: Mood = mood;
  if (mood === "think") frame = tick % 2 ? "think" : "think2";
  else if (blinking) frame = "blink";

  return (
    <div className="robot" aria-hidden="true">
      <pre>{robotArt(id, frame)}</pre>
    </div>
  );
}
