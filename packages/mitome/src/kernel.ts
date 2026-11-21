/**
 * The layer under an Agent: one Session without an Agent, and the controlled `step`, `loop` and
 * `localTools` its Turns run. It is for tests of a Provider and for building another runtime; an
 * Agent's program uses the `step` and `loop` it is given, which carry the Agent's Instructions,
 * Tools and policies.
 *
 * @module @mitome/core/kernel
 */

export * as Session from "./session/session.js";
export { localTools, loop, step } from "./session/step.js";
export type { LocalTools, StepOptions } from "./session/step.js";
