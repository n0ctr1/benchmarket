/**
 * Sound for the round replay. Short CC0 samples (public/sfx, see CREDITS.md there), all put
 * through one bitcrush and dither pass so they read as one lo-fi set. If a sample cannot load,
 * the same event is synthesized with Web Audio instead. Every sound is short and quiet by
 * design; the header control mutes it or sets the volume, remembered per browser.
 */

type Sample = "launch" | "land" | "lock" | "blip" | "tick" | "stamp" | "sweep" | "fanfare";

/** Mix level of each sample, so loud and soft sources sit together. */
const MIX: Record<Sample, number> = { launch: 0.5, land: 0.55, lock: 0.5, blip: 0.32, tick: 0.16, stamp: 0.45, sweep: 0.42, fanfare: 0.6 };

type Listener = () => void;

const KEY = "agent-league:sound";

interface Settings {
  volume: number;
  muted: boolean;
}

function load(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (s && typeof s.volume === "number" && typeof s.muted === "boolean") return { volume: Math.max(0, Math.min(1, s.volume)), muted: s.muted };
  } catch {
    // Storage may be blocked; the defaults below still work.
  }
  return { volume: 0.5, muted: false };
}

class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private buffers: Partial<Record<Sample, AudioBuffer>> = {};
  private listeners = new Set<Listener>();
  settings: Settings = load();

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  set(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.settings));
    } catch {
      // Not saved; the setting still applies for this visit.
    }
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.02);
    this.listeners.forEach((l) => l());
  }

  private level() {
    // A perceptual curve: the slider's middle should sound like the middle.
    return this.settings.muted ? 0 : this.settings.volume ** 2 * 0.9;
  }

  /** Call from a user gesture (the replay button) so the browser lets audio start. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.level();
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.load();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  private load() {
    const c = this.ctx!;
    (Object.keys(MIX) as Sample[]).forEach(async (name) => {
      try {
        const r = await fetch(`${import.meta.env.BASE_URL}sfx/${name}.mp3`);
        if (!r.ok) return;
        this.buffers[name] = await c.decodeAudioData(await r.arrayBuffer());
      } catch {
        // Missing or undecodable: this event falls back to the synthesized sound.
      }
    });
  }

  /** Plays a sample if it loaded; false means the caller should synthesize instead. */
  private sample(name: Sample, delayMs = 0, rate = 1, gain = 1): boolean {
    const buf = this.buffers[name];
    if (!buf) return false;
    const c = this.ctx!;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = c.createGain();
    g.gain.value = MIX[name] * gain;
    src.connect(g).connect(this.master!);
    src.start(c.currentTime + delayMs / 1000);
    return true;
  }

  private ready() {
    return !!this.ctx && !!this.master && !this.settings.muted && this.settings.volume > 0;
  }

  private tone(freq: number, start: number, dur: number, { type = "sine" as OscillatorType, gain = 0.2, to, attack = 0.005 }: { type?: OscillatorType; gain?: number; to?: number; attack?: number } = {}) {
    const c = this.ctx!;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, start);
    if (to) o.frequency.exponentialRampToValueAtTime(to, start + dur);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(gain, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(this.master!);
    o.start(start);
    o.stop(start + dur + 0.05);
  }

  private noise(start: number, dur: number, { gain = 0.1, from = 800, to = 3000, q = 1.2 }: { gain?: number; from?: number; to?: number; q?: number } = {}) {
    const c = this.ctx!;
    const s = c.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = q;
    f.frequency.setValueAtTime(from, start);
    f.frequency.exponentialRampToValueAtTime(to, start + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(gain, start + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    s.connect(f).connect(g).connect(this.master!);
    s.start(start, Math.random() * 0.5);
    s.stop(start + dur + 0.05);
  }

  private now(delayMs = 0) {
    return this.ctx!.currentTime + delayMs / 1000;
  }

  /** A scout's bet leaves: a soft rising whoosh. */
  launch() {
    if (!this.ready() || this.sample("launch")) return;
    const t = this.now();
    this.noise(t, 0.65, { gain: 0.08, from: 500, to: 2600, q: 0.9 });
    this.tone(320, t, 0.6, { type: "sine", gain: 0.05, to: 880, attack: 0.2 });
  }

  /** The bet lands and the price moves: a coin chime. */
  land(delayMs = 0) {
    if (!this.ready() || this.sample("land", delayMs)) return;
    const t = this.now(delayMs);
    this.tone(1318.5, t, 0.5, { type: "sine", gain: 0.12 });
    this.tone(1975.5, t + 0.06, 0.6, { type: "sine", gain: 0.09 });
    this.tone(160, t, 0.15, { type: "sine", gain: 0.12, to: 90 });
  }

  /** The market locks: a low clunk. */
  lock() {
    if (!this.ready() || this.sample("lock")) return;
    const t = this.now();
    this.tone(140, t, 0.25, { type: "square", gain: 0.06, to: 70 });
    this.noise(t, 0.08, { gain: 0.12, from: 2000, to: 600, q: 0.7 });
  }

  /** An answer goes in: a short rising blip. */
  blip() {
    if (!this.ready() || this.sample("blip")) return;
    const t = this.now();
    this.tone(880, t, 0.09, { type: "triangle", gain: 0.08, to: 1320 });
    this.tone(1760, t + 0.07, 0.07, { type: "triangle", gain: 0.04 });
  }

  /** Hidden tests run: one tick per test, pitch climbing; then the verifier's stamp. */
  tests(count: number, overMs: number) {
    if (!this.ready() || count <= 0) return;
    if (this.buffers.tick && this.buffers.stamp) {
      // One tick per test, pitched up as the run goes, then the verifier's stamp.
      for (let k = 0; k < count; k++) this.sample("tick", (k / count) * overMs, 1 + (k / count) * 0.6);
      this.sample("stamp", overMs);
      return;
    }
    const t = this.now();
    for (let k = 0; k < count; k++) {
      const at = t + (k / count) * (overMs / 1000);
      this.tone(900 + (k / count) * 900, at, 0.03, { type: "square", gain: 0.025 });
    }
    const end = t + overMs / 1000;
    this.tone(220, end, 0.18, { type: "triangle", gain: 0.12, to: 180 });
    this.noise(end, 0.06, { gain: 0.1, from: 3000, to: 1200, q: 0.8 });
  }

  /** The dispute window: a watcher re-runs everything, a scanner sweep. */
  sweep(durMs: number) {
    if (!this.ready() || this.sample("sweep")) return;
    const t = this.now();
    this.noise(t, durMs / 1000, { gain: 0.05, from: 300, to: 4000, q: 4 });
    this.tone(660, t + durMs / 1000, 0.25, { type: "sine", gain: 0.06 });
  }

  /** The result: a short rising arpeggio and a held chord. */
  fanfare() {
    if (!this.ready() || this.sample("fanfare")) return;
    const t = this.now();
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, t + i * 0.11, 0.35, { type: "triangle", gain: 0.1 }));
    [523.25, 659.25, 783.99].forEach((f) => this.tone(f, t + 0.48, 1.2, { type: "sine", gain: 0.06, attack: 0.04 }));
  }
}

export const sfx = new Sfx();
