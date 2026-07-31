import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import type { AnyExtension } from "../../src/extension.js";
import { beginHookPhase } from "../../src/session/hooks.js";

const extensions = (...names: ReadonlyArray<string>): ReadonlyArray<AnyExtension> =>
  names.map((name) => ({ name }));

describe("Hook phases", () => {
  it.effect("continues cleanup after an end Hook is interrupted", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const phase = yield* beginHookPhase(
        extensions("first", "second"),
        () => Effect.void,
        (extension) =>
          Effect.sync(() => void log.push(extension.name)).pipe(
            Effect.andThen(extension.name === "first" ? Effect.interrupt : Effect.void),
          ),
        "end failed",
      );

      expect(Exit.isFailure(yield* Effect.exit(phase.end))).toBe(true);
      yield* phase.cleanup;

      expect(log).toEqual(["first", "second"]);
    }),
  );

  it.effect("reports the first end Hook error after running later end Hooks", () =>
    Effect.gen(function* () {
      const first = new Error("first");
      const second = new Error("second");
      const log: Array<string> = [];
      const phase = yield* beginHookPhase(
        extensions("first", "second", "third"),
        () => Effect.void,
        (extension) =>
          Effect.sync(() => void log.push(extension.name)).pipe(
            Effect.andThen(
              extension.name === "first"
                ? Effect.fail(first)
                : extension.name === "second"
                  ? Effect.fail(second)
                  : Effect.void,
            ),
          ),
        "end failed",
      );

      expect(yield* Effect.flip(phase.end)).toBe(first);
      expect(log).toEqual(["first", "second", "third"]);
    }),
  );
});
