import { useSyncExternalStore } from "react";
import { sfx } from "./sound";

/** Header control: a speaker button mutes, the slider sets the volume. */
export function SoundControl() {
  const s = useSyncExternalStore(
    (l) => sfx.subscribe(l),
    () => sfx.settings,
  );
  const off = s.muted || s.volume === 0;
  return (
    <div className="sound" role="group" aria-label="Sound">
      <button
        className="sound-btn"
        onClick={() => {
          sfx.unlock();
          sfx.set(off && s.volume === 0 ? { muted: false, volume: 0.5 } : { muted: !s.muted });
        }}
        aria-pressed={!off}
        aria-label={off ? "Turn sound on" : "Mute sound"}
        title={off ? "Sound off" : "Sound on"}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path d="M2 6.5h3l4-3.5v12l-4-3.5H2z" fill="currentColor" />
          {off ? (
            <path d="M12 6.5l4 5M16 6.5l-4 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          ) : (
            <>
              <path d="M11.5 6.2a3.6 3.6 0 0 1 0 5.6" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
              {s.volume > 0.5 && <path d="M13.6 4a6.6 6.6 0 0 1 0 10" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />}
            </>
          )}
        </svg>
      </button>
      <input
        className="sound-range"
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round((s.muted ? 0 : s.volume) * 100)}
        onChange={(e) => {
          sfx.unlock();
          const v = Number(e.target.value) / 100;
          sfx.set({ volume: v, muted: v === 0 });
        }}
        aria-label="Volume"
        style={{ ["--fill" as string]: `${Math.round((s.muted ? 0 : s.volume) * 100)}%` }}
      />
    </div>
  );
}
