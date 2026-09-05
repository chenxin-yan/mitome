import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import type { AnyExtension } from "../../src/extension.js";
import { beginHookPhase } from "../../src/session/hooks.js";

const extensions = (...names: ReadonlyArray<string>): ReadonlyArray<AnyExtension> =>
  names.map((name) => ({ name }));

describe("Hook phases", () => {
  it.effect(
    "runs end Hooks in reverse Definition order and resumes cleanup where end stopped",
    () =>
      Effect.gen(function* () {
        const log: Array<string> = [];
        const phase = yield* beginHookPhase(
          extensions("first", "second", "third"),
          () => Effect.void,
          (extension) =>
            Effect.sync(() => void log.push(extension.name!)).pipe(
              Effect.andThen(extension.name === "second" ? Effect.interrupt : Effect.void),
            ),
          "end failed",
        );

        expect(Exit.isFailure(yield* Effect.exit(phase.end))).toBe(true);
        expect(log).toEqual(["third", "second"]);
        yield* phase.cleanup;
        expect(log).toEqual(["third", "second", "first"]);
      }),
  );

  it.effect("ends only the started Extensions, in reverse order, when a start Hook fails", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const exit = yield* Effect.exit(
        beginHookPhase(
          extensions("first", "second", "third"),
          (extension) => (extension.name === "third" ? Effect.fail("start failed") : Effect.void),
          (extension) => Effect.sync(() => void log.push(extension.name!)),
          "end failed",
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(log).toEqual(["second", "first"]);
    }),
  );

  it.effect("reports the first end Hook error after running remaining end Hooks", () =>
    Effect.gen(function* () {
      const first = new Error("first");
      const second = new Error("second");
      const log: Array<string> = [];
      const phase = yield* beginHookPhase(
        extensions("first", "second", "third"),
        () => Effect.void,
        (extension) =>
          Effect.sync(() => void log.push(extension.name!)).pipe(
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

      expect(yield* Effect.flip(phase.end)).toBe(second);
      expect(log).toEqual(["third", "second", "first"]);
    }),
  );
});
