// Some wallet modules expect Node's Buffer and `global` in the browser.
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer; global?: typeof globalThis; process?: { env: Record<string, string>; browser: boolean; version: string; nextTick: (f: () => void) => void } };
g.Buffer ??= Buffer;
g.global ??= globalThis;
g.process ??= { env: {}, browser: true, version: "", nextTick: (f) => queueMicrotask(f) };
