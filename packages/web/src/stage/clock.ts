/**
 * The replay's clock. The stage and the round's playback read time from here, so pausing or
 * changing speed freezes or slows both together: beams in flight stop mid-air on pause.
 */
let base = performance.now();
let virtual = 0;
let speed = 1;
let paused = false;
const listeners = new Set<() => void>();

function sync() {
  const real = performance.now();
  if (!paused) virtual += (real - base) * speed;
  base = real;
}

export const clock = {
  now(): number {
    sync();
    return virtual;
  },
  get speed() {
    return speed;
  },
  get paused() {
    return paused;
  },
  setSpeed(s: number) {
    sync();
    speed = s;
    listeners.forEach((l) => l());
  },
  setPaused(p: boolean) {
    sync();
    paused = p;
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};
