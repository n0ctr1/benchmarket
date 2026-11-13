import { useEffect, useRef } from "react";
import { clock } from "./clock";
import { faceGrid } from "@benchmarket/shared/identity";

/**
 * The round as a small 3D scene drawn in text. A software rasterizer fills a character grid:
 * each agent is a cube with its face, held up by a beam whose height is the data (the market
 * price, then the score). Scouts stand in front; a bet flies as a beam of light from the scout
 * to the agent it bought. Everything that moves is driven by timestamps in the scene, so the
 * parent only says what happens and when.
 */

export interface StageAgent {
  id: string;
  name: string;
  cells: number[];
  palette?: readonly number[];
  /** 0..1: the price while the market runs, the share of tests passed once scored. */
  value: number;
  /** Text above the agent: a price, a score, or "···" while it thinks. */
  label: string;
  win: boolean;
  /** Settled and not a winner. */
  lost: boolean;
  /** clock.now() when its answer went in: a scan line climbs it. */
  scanAt?: number;
}

export interface StageScout {
  id: string;
  face: string;
  line: string;
  /** What the scout says right now: shown in a bubble above it. */
  says?: string;
}

export interface StageBet {
  scout: number;
  agent: number;
  /** clock.now() when the bet was placed. */
  at: number;
  /** The target's value and label before the bet lands. */
  before: { value: number; label: string };
}

export interface Scene {
  agents: StageAgent[];
  scouts: StageScout[];
  bet: StageBet | null;
  /** clock.now() when the dispute window opened: a re-check sweeps the floor. */
  sweepAt: number | null;
  settled: boolean;
}

type V3 = [number, number, number];
const v3 = (x: number, y: number, z: number): V3 => [x, y, z];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

const RAMP = " .:-=+*";
const ACC: V3 = [212, 255, 0];
const LEVELS = 14;
const LEVEL_H = 0.3;
const BEAM_MS = 700;
const SCAN_MS = 1100;
const SWEEP_MS = 1700;

/** Face pixel color: hsl(h 85% 60%), the same as the identicons in the page. */
export function faceRgb(h: number): V3 {
  const s = 0.85;
  const l = 0.6;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
}

/** Agents stand on an arc that opens toward the camera. */
function spot(i: number, n: number): [number, number] {
  if (n <= 1) return [0, -2.9];
  const u = i / (n - 1);
  return [lerp(-7.6, 7.6, u), -0.6 - 2.3 * Math.sin(Math.PI * u)];
}
const scoutX = (j: number, m: number) => (j - (m - 1) / 2) * 4.4;

interface Tri {
  a: V3;
  b: V3;
  c: V3;
  col: V3;
  lum?: number;
  ch?: string;
  scan?: number | null;
  face?: { grid: Array<Array<V3 | null>>; x0: number; y1: number; s: number; dim: number };
  agent?: number;
}

interface Buf {
  n: number;
  z: Float32Array;
  lum: Float32Array;
  r: Uint8Array;
  g: Uint8Array;
  b: Uint8Array;
  chr: Array<string | null>;
  ag: Int16Array;
}

/** Size of one stage character in device pixels, so page zoom shows more of them, not bigger ones. */
const GLYPH = 4;

export function Stage({ scene, picked, onPick, label }: { scene: Scene; picked: number | null; onPick: (i: number) => void; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const hoverRef = useRef<number | null>(null);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const hits = useRef<Array<{ i: number; x: number; y0: number; y1: number }>>([]);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    let raf = 0;
    let buf: Buf | null = null;
    let levels: number[] = [];
    let lastStep = 0;
    let dust: Array<{ x: number; y: number; z: number; v: number; ph: number }> = [];
    {
      let sd = 7;
      const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
      dust = Array.from({ length: 170 }, () => ({ x: (rnd() - 0.5) * 34, y: rnd() * 9, z: -16 + rnd() * 22, v: 0.15 + rnd() * 0.35, ph: rnd() * 6.28 }));
    }
    const reduceQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const t = clock.now();
      const S = sceneRef.current;
      const W = cv.clientWidth;
      const H = cv.clientHeight;
      if (!W || !H) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(W * dpr);
        cv.height = Math.round(H * dpr);
      }
      const ctx = cv.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const reduce = !!reduceQuery?.matches;
      // Characters are sized in device pixels, so page zoom shows more of them, not bigger ones.
      const gf = GLYPH / (window.devicePixelRatio || 1);
      ctx.font = `${gf}px 'IBM Plex Mono', monospace`;
      const cw = ctx.measureText("M").width || 5.4;
      const ch = gf * (10 / 9);
      const C = Math.floor(W / cw);
      const R = Math.floor(H / ch);
      const N = C * R;
      if (!buf || buf.n !== N) buf = { n: N, z: new Float32Array(N), lum: new Float32Array(N), r: new Uint8Array(N), g: new Uint8Array(N), b: new Uint8Array(N), chr: new Array(N), ag: new Int16Array(N) };
      const B = buf;
      B.z.fill(0);
      B.lum.fill(0);
      B.chr.fill(null);
      B.ag.fill(-1);

      // Camera: a slow sway left and right, so parallax gives the scene depth.
      const sway = reduce ? 0 : Math.sin(t / 7000);
      const E = v3(sway * 2.4, 5.4 + (reduce ? 0 : Math.cos(t / 9000) * 0.15), 17);
      const T = v3(sway * 0.5, 1.6, -0.6);
      const f = norm(sub(T, E));
      const r = norm(cross(f, [0, 1, 0]));
      const u = cross(r, f);
      // Narrow screens: pull back until the outer agents fit across the width.
      const F = Math.min(H / 2 / Math.tan((38 * Math.PI) / 360), (W / 2) * (19 / 9.8));
      const proj = (P: V3) => {
        const d = sub(P, E);
        const z = dot(d, f);
        return { x: W / 2 + (dot(d, r) / z) * F, y: H / 2 - (dot(d, u) / z) * F, z };
      };
      const L = norm([-0.55, 0.9, 0.5]);

      const n = S.agents.length;
      const bet = S.bet;
      const betAge = bet ? t - bet.at : -1;
      const landed = !bet || betAge >= BEAM_MS;
      // While a bet flies, the agent it lands on keeps full light and the rest step back.
      const focus = bet && betAge >= 0 && betAge < BEAM_MS + 900 ? bet.agent : null;

      // Beams change one level at a time: a smooth slide makes edges crawl across cells.
      if (levels.length !== n) levels = S.agents.map((a) => Math.round(a.value * LEVELS));
      const step = reduce || t - lastStep >= 90;
      if (step) lastStep = t;

      const tris: Tri[] = [];
      const add = (a: V3, b: V3, c: V3, col: V3, o: Partial<Tri> = {}) => tris.push({ a, b, c, col, ...o });
      const quad = (p0: V3, p1: V3, p2: V3, p3: V3, col: V3, o: Partial<Tri> = {}) => {
        add(p0, p1, p2, col, o);
        add(p0, p2, p3, col, o);
      };
      const box = (cx: number, y0: number, cz: number, w: number, h: number, d: number, col: V3, o: Partial<Tri> = {}) => {
        const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, y1 = y0 + h;
        const P = [v3(x0, y0, z0), v3(x1, y0, z0), v3(x1, y1, z0), v3(x0, y1, z0), v3(x0, y0, z1), v3(x1, y0, z1), v3(x1, y1, z1), v3(x0, y1, z1)];
        quad(P[4], P[5], P[6], P[7], col, o);
        quad(P[1], P[0], P[3], P[2], col, o);
        quad(P[0], P[4], P[7], P[3], col, o);
        quad(P[5], P[1], P[2], P[6], col, o);
        quad(P[3], P[7], P[6], P[2], col, o);
      };

      const heads: Array<{ i: number; top: V3; base: V3 }> = [];
      S.agents.forEach((ag, i) => {
        const [x, z] = spot(i, n);
        const value = bet && bet.agent === i && !landed ? bet.before.value : ag.value;
        const goal = Math.round(Math.max(0, Math.min(1, value)) * LEVELS);
        if (step && levels[i] !== goal) levels[i] = reduce ? goal : levels[i] + Math.sign(goal - levels[i]);
        const h = levels[i] * LEVEL_H;
        const dim = ag.lost || (focus !== null && focus !== i) ? 0.62 : 1;
        const tone: V3 = ag.win ? ACC : [240 * dim, 240 * dim, 246 * dim];
        const sp = ag.scanAt !== undefined ? (t - ag.scanAt) / SCAN_MS : -1;
        const scan = sp >= 0 && sp <= 1 ? sp * (h + 1.9) : null;
        box(x, 0, z, 1.6, 0.05, 1.6, tone, { scan, lum: 0.8, agent: i });
        if (h > 0.1) box(x, 0.05, z, 0.34, h - 0.05, 0.34, tone, { scan, lum: 1.05, ch: ":", agent: i });
        const cy = h + 0.06;
        const s = 1.75;
        box(x, cy, z, s, s, s, tone, { scan, agent: i });
        const grid = faceGrid(ag.cells).map((row) => row.map((v) => (v && ag.palette ? faceRgb(ag.palette[v - 1]) : null)));
        const fz = z + s / 2 + 0.002;
        quad(v3(x - s / 2, cy, fz), v3(x + s / 2, cy, fz), v3(x + s / 2, cy + s, fz), v3(x - s / 2, cy + s, fz), tone, {
          scan,
          agent: i,
          face: { grid, x0: x - s / 2, y1: cy + s, s, dim: dim < 1 ? 0.55 : 1 },
        });
        heads.push({ i, top: v3(x, cy + s + 0.45, z), base: v3(x, 0, z + 1.35) });
      });

      for (const tr of tris) {
        const pa = proj(tr.a), pb = proj(tr.b), pc = proj(tr.c);
        if (pa.z < 0.3 || pb.z < 0.3 || pc.z < 0.3) continue;
        const area = (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y);
        if (area >= 0) continue; // back face: screen y points down
        const nn = norm(cross(sub(tr.b, tr.a), sub(tr.c, tr.a)));
        const base = 0.45 + 0.75 * Math.max(0, dot(nn, L));
        const minX = Math.max(0, Math.floor(Math.min(pa.x, pb.x, pc.x) / cw)), maxX = Math.min(C - 1, Math.ceil(Math.max(pa.x, pb.x, pc.x) / cw));
        const minY = Math.max(0, Math.floor(Math.min(pa.y, pb.y, pc.y) / ch)), maxY = Math.min(R - 1, Math.ceil(Math.max(pa.y, pb.y, pc.y) / ch));
        const iza = 1 / pa.z, izb = 1 / pb.z, izc = 1 / pc.z;
        for (let cy = minY; cy <= maxY; cy++) {
          const py = (cy + 0.5) * ch;
          for (let cx = minX; cx <= maxX; cx++) {
            const px = (cx + 0.5) * cw;
            const w0 = ((pb.x - px) * (pc.y - py) - (pc.x - px) * (pb.y - py)) / area;
            const w1 = ((pc.x - px) * (pa.y - py) - (pa.x - px) * (pc.y - py)) / area;
            const w2 = 1 - w0 - w1;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            const iz = w0 * iza + w1 * izb + w2 * izc;
            const idx = cy * C + cx;
            if (iz <= B.z[idx] + 1e-6) continue;
            B.z[idx] = iz;
            const wa = (w0 * iza) / iz, wb = (w1 * izb) / iz, wc = (w2 * izc) / iz;
            const sy = wa * tr.a[1] + wb * tr.b[1] + wc * tr.c[1];
            let lum = tr.lum ?? base;
            let chr = tr.ch ?? null;
            let col = tr.col;
            if (tr.face) {
              // The agent's 7x7 face, cut into the front of its cube.
              const sx = wa * tr.a[0] + wb * tr.b[0] + wc * tr.c[0];
              const gx = Math.floor(((sx - tr.face.x0) / tr.face.s) * 9) - 1;
              const gy = Math.floor(((tr.face.y1 - sy) / tr.face.s) * 9) - 1;
              const cell = gx >= 0 && gx < 7 && gy >= 0 && gy < 7 ? tr.face.grid[gy][gx] : null;
              lum = cell ? 1.2 * tr.face.dim : 0;
              chr = cell ? "#" : null;
              if (cell) col = cell;
            }
            if (tr.scan !== null && tr.scan !== undefined && Math.abs(sy - tr.scan) < 0.16) {
              lum = 1.25;
              chr = "-";
            }
            B.lum[idx] = lum;
            B.r[idx] = col[0];
            B.g[idx] = col[1];
            B.b[idx] = col[2];
            B.chr[idx] = chr;
            B.ag[idx] = tr.agent ?? -1;
          }
        }
      }

      // Hover: the agent under the cursor gets an outline in the signal colour.
      const hov = hoverRef.current;
      if (hov !== null) {
        for (let cy = 1; cy < R - 1; cy++)
          for (let cx = 1; cx < C - 1; cx++) {
            const idx = cy * C + cx;
            if (B.ag[idx] !== hov) continue;
            if (B.ag[idx - 1] === hov && B.ag[idx + 1] === hov && B.ag[idx - C] === hov && B.ag[idx + C] === hov) continue;
            B.r[idx] = 212;
            B.g[idx] = 255;
            B.b[idx] = 0;
            B.lum[idx] = 1.25;
            B.chr[idx] = "#";
          }
      }

      // Floor: a sparse field of points. In the dispute window a re-check sweeps across it.
      const sweep = S.sweepAt !== null && t - S.sweepAt < SWEEP_MS + 200 ? lerp(-12, 12, ease((t - S.sweepAt) / SWEEP_MS)) : null;
      const sweepDone = S.sweepAt !== null ? lerp(-12, 12, ease((t - S.sweepAt) / SWEEP_MS)) : null;
      for (let gz = -9; gz <= 7; gz += 1) {
        for (let gx = -12; gx <= 12; gx += 1) {
          const dx = gx / 12, dz = (gz + 1.2) / 8;
          if (dx * dx + dz * dz > 1) continue;
          const p = proj(v3(gx, 0, gz));
          if (p.z < 0.3) continue;
          const cx = Math.floor(p.x / cw), cy = Math.floor(p.y / ch);
          if (cx < 0 || cy < 0 || cx >= C || cy >= R) continue;
          const idx = cy * C + cx, iz = 1 / p.z;
          if (iz <= B.z[idx]) continue;
          const near = sweep !== null && Math.abs(gx - sweep) < 0.8;
          B.z[idx] = iz;
          B.lum[idx] = near ? 1.1 : 0.55 * (1 - 0.5 * (dx * dx + dz * dz));
          const c: V3 = near ? [123, 224, 138] : [150, 150, 158];
          B.r[idx] = c[0];
          B.g[idx] = c[1];
          B.b[idx] = c[2];
          B.chr[idx] = near ? "+" : ".";
        }
      }

      // Dust: slow particles through the volume, dimmer and smaller the farther they are.
      const ts = reduce ? 0 : t / 1000;
      for (const d of dust) {
        const P = v3(d.x + Math.sin(ts * 0.21 + d.ph) * 0.5, (d.y + ts * d.v * 0.25) % 9, d.z + Math.cos(ts * 0.17 + d.ph) * 0.4);
        const p = proj(P);
        if (p.z < 1) continue;
        const cx = Math.floor(p.x / cw), cy = Math.floor(p.y / ch);
        if (cx < 0 || cy < 0 || cx >= C || cy >= R) continue;
        const idx = cy * C + cx, iz = 1 / p.z;
        if (iz <= B.z[idx]) continue;
        const near = Math.max(0, Math.min(1, (26 - p.z) / 18));
        const tw = 0.75 + 0.25 * Math.sin(ts * 1.3 + d.ph * 3);
        B.z[idx] = iz;
        B.lum[idx] = (0.22 + 0.7 * near) * tw;
        B.r[idx] = 170;
        B.g[idx] = 170;
        B.b[idx] = 182;
        B.chr[idx] = near > 0.75 ? "+" : near > 0.4 ? "·" : ".";
      }

      // The character buffer, one fillStyle per color.
      ctx.clearRect(0, 0, W, H);
      ctx.textBaseline = "top";
      ctx.font = `${gf}px 'IBM Plex Mono', monospace`;
      const groups = new Map<string, Array<number | string>>();
      for (let idx = 0; idx < N; idx++) {
        const lum = B.lum[idx];
        if (lum <= 0) continue;
        const l = Math.min(1.25, lum);
        const chx = B.chr[idx] || RAMP[Math.min(RAMP.length - 1, Math.max(1, Math.round(l * (RAMP.length - 1))))];
        const m = Math.min(1, 0.5 + l * 0.6);
        const key = `rgb(${(B.r[idx] * m) & 0xf8},${(B.g[idx] * m) & 0xf8},${(B.b[idx] * m) & 0xf8})`;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = []));
        g.push(idx, chx);
      }
      for (const [key, g] of groups) {
        ctx.fillStyle = key;
        for (let j = 0; j < g.length; j += 2) {
          const idx = g[j] as number;
          ctx.fillText(g[j + 1] as string, (idx % C) * cw, Math.floor(idx / C) * ch);
        }
      }

      // HUD: a number above each agent, its name below; the scouts in the front row.
      const text = (x: number, y: number, s: string, font: string, color: string) => {
        ctx.font = font;
        ctx.fillStyle = color;
        ctx.textAlign = "center";
        ctx.fillText(s, x, y);
        ctx.textAlign = "left";
      };
      const out: typeof hits.current = [];
      for (const hd of heads) {
        const ag = S.agents[hd.i];
        const pt = proj(hd.top), pb = proj(hd.base);
        if (pt.z < 0.3 || pb.z < 0.3) continue;
        let label = bet && bet.agent === hd.i && !landed ? bet.before.label : ag.label;
        const checked = sweepDone !== null && sweepDone > spot(hd.i, n)[0];
        if (S.sweepAt !== null && checked) label += " ✓";
        const flash = bet && bet.agent === hd.i && betAge >= BEAM_MS && betAge < BEAM_MS + 1100;
        const picked = pickedRef.current === hd.i;
        text(pt.x, pt.y - 7, label, `600 12px 'IBM Plex Mono', monospace`, ag.win || flash ? "#D4FF00" : S.settled ? "#5A5A55" : "#ECEBE4");
        text(pb.x, pb.y - 9, ag.name.toUpperCase(), `700 13px 'IBM Plex Mono', monospace`, ag.win ? "#D4FF00" : picked ? "#ECEBE4" : "#8B8B85");
        if (picked) {
          ctx.fillStyle = "#ECEBE4";
          ctx.fillRect(pb.x - 14, pb.y + 14, 28, 2);
        }
        out.push({ i: hd.i, x: pt.x, y0: pt.y - 14, y1: pb.y + 18 });
      }
      hits.current = out;

      // A bet: a thin beam of light from the scout to the agent. A bright head travels the
      // arc, the beam fades after it lands, and a ring spreads on the agent's plate.
      const m = S.scouts.length;
      if (bet && betAge >= 0 && betAge < BEAM_MS * 2.6) {
        const s2 = betAge / BEAM_MS;
        const [x, z] = spot(bet.agent, n);
        const from = v3(scoutX(bet.scout, m), 0.55, 4.6), to = v3(x, 0.06, z);
        const at = (q: number) => proj(v3(lerp(from[0], to[0], q), lerp(from[1], to[1], q) + Math.sin(Math.PI * q) * 2.2, lerp(from[2], to[2], q)));
        const e = ease(Math.min(1, s2));
        const fade = s2 <= 1 ? 1 : Math.max(0, 1 - (s2 - 1) / 1.6);
        ctx.save();
        ctx.lineCap = "round";
        const trace = (wd: number, alpha: number, blur: number) => {
          ctx.beginPath();
          for (let q = 0; q <= e + 1e-6; q += 0.02) {
            const p = at(Math.min(q, e));
            if (q === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
          }
          ctx.lineWidth = wd;
          ctx.strokeStyle = `rgba(212,255,0,${alpha * fade})`;
          ctx.shadowColor = "rgba(212,255,0,.9)";
          ctx.shadowBlur = blur;
          ctx.stroke();
        };
        trace(5, 0.12, 14);
        trace(1.4, 0.95, 6);
        if (s2 < 1) {
          const hq = at(e);
          ctx.fillStyle = "#F4FFC2";
          ctx.shadowColor = "rgba(212,255,0,1)";
          ctx.shadowBlur = 16;
          ctx.beginPath();
          ctx.arc(hq.x, hq.y, 3.2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          const rr = 0.6 + (s2 - 1) * 1.4;
          ctx.shadowBlur = 0;
          ctx.strokeStyle = `rgba(212,255,0,${0.8 * fade})`;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          for (let a2 = 0; a2 <= 64; a2++) {
            const an = (a2 / 64) * Math.PI * 2;
            const q = proj(v3(x + Math.cos(an) * rr, 0.07, z + Math.sin(an) * rr));
            if (a2 === 0) ctx.moveTo(q.x, q.y);
            else ctx.lineTo(q.x, q.y);
          }
          ctx.stroke();
        }
        ctx.restore();
      }
      S.scouts.forEach((sc, j) => {
        const p = proj(v3(scoutX(j, m), 0, 4.6));
        if (p.z < 0.3) return;
        const betting = !!bet && bet.scout === j && betAge >= 0 && betAge < BEAM_MS + 900;
        text(p.x, p.y - 12, sc.face, `600 18px 'IBM Plex Mono', monospace`, betting ? "#D4FF00" : "#ECEBE4");
        text(p.x, p.y + 10, sc.id, `500 11px 'IBM Plex Mono', monospace`, "#5A5A55");
        text(p.x, p.y + 26, sc.line, `600 11px 'IBM Plex Mono', monospace`, betting ? "#D4FF00" : "#8B8B85");
        if (sc.says) {
          // Word-wrapped bubble above the scout, kept inside the stage.
          ctx.font = `500 11.5px 'IBM Plex Mono', monospace`;
          const maxW = Math.min(300, W * 0.42);
          const words = sc.says.split(/\s+/);
          const lines: string[] = [];
          let cur = "";
          for (const wd of words) {
            const next = cur ? cur + " " + wd : wd;
            if (ctx.measureText(next).width > maxW && cur) {
              lines.push(cur);
              cur = wd;
            } else cur = next;
            if (lines.length === 4) break;
          }
          if (lines.length < 4 && cur) lines.push(cur);
          else if (lines.length === 4) lines[3] = lines[3].replace(/.{0,2}$/, "…");
          const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20;
          const bh = lines.length * 15 + 14;
          const bx = Math.max(6, Math.min(W - bw - 6, p.x - bw / 2));
          const by = Math.max(6, p.y - 36 - bh);
          ctx.fillStyle = "rgba(11,11,11,0.94)";
          ctx.fillRect(bx, by, bw, bh);
          ctx.strokeStyle = "#D4FF00";
          ctx.lineWidth = 1.5;
          ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
          ctx.beginPath();
          ctx.moveTo(p.x - 6, by + bh);
          ctx.lineTo(p.x, by + bh + 8);
          ctx.lineTo(p.x + 6, by + bh);
          ctx.fillStyle = "#D4FF00";
          ctx.fill();
          ctx.fillStyle = "#ECEBE4";
          ctx.textAlign = "left";
          lines.forEach((l, k) => ctx.fillText(l, bx + 10, by + 8 + k * 15));
        }
      });
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const click = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = hits.current.filter((h) => y >= h.y0 && y <= h.y1).sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0];
    if (hit && Math.abs(hit.x - x) < 70) onPick(hit.i);
  };

  const move = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = hits.current.filter((h) => y >= h.y0 && y <= h.y1).sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0];
    const i = hit && Math.abs(hit.x - x) < 70 ? hit.i : null;
    hoverRef.current = i;
    e.currentTarget.style.cursor = i === null ? "default" : "pointer";
  };

  return (
    <canvas
      ref={canvas}
      className="stage-canvas"
      onClick={click}
      onMouseMove={move}
      onMouseLeave={() => (hoverRef.current = null)}
      role="img"
      aria-label={label}
    />
  );
}
