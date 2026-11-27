// Compile-only fixture: an Agent's program uses the `step` and `loop` it is given, which carry the
// Agent's Instructions, Tools and policies; the raw ones are only in `@mitome/core/kernel`.

// @ts-expect-error The root entry has no raw loop.
import { loop } from "../src/index.js";
// @ts-expect-error The root entry has no raw step.
import { step } from "../src/index.js";
// @ts-expect-error The root entry has no localTools.
import { localTools } from "../src/index.js";

export const raw = [loop, step, localTools];
