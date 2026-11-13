// Some wallet modules expect Node's Buffer and `global` in the browser.
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer; global?: typeof globalThis };
g.Buffer ??= Buffer;
g.global ??= globalThis;
