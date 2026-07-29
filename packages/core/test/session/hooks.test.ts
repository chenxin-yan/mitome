import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { Prompt } from "effect/unstable/ai";
import type { AnyPlugin } from "../../src/plugin.js";
import { beginHookPhase, transformPrompt } from "../../src/session/hooks.js";

const plugins = (...names: ReadonlyArray<string>): ReadonlyArray<AnyPlugin> =>
  names.map((name) => ({ name }));

describe("Hook phases", () => {
  it.effect("passes pre-Step transformations in Agent Definition order", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const ordered: ReadonlyArray<AnyPlugin> = ["first", "second"].map((name) => ({
        name,
        hooks: {
          preStep: (prompt) => {
            log.push(name);
            return Effect.succeed(Prompt.concat(prompt, name));
          },
        },
      }));

      const transformed = yield* transformPrompt(ordered, new Map(), Prompt.make("start"));

      expect(log).toEqual(["first", "second"]);
      expect(transformed.content.map((message) => message.role)).toEqual(["user", "user", "user"]);
    }),
  );

  it.effect("runs start and end Hooks in Agent Definition order", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const phase = yield* beginHookPhase(
        plugins("first", "second"),
        (plugin) => Effect.sync(() => void log.push(`start:${plugin.name}`)),
        (plugin) => Effect.sync(() => void log.push(`end:${plugin.name}`)),
        "end failed",
      );

      yield* phase.end;
      yield* phase.cleanup;

      expect(log).toEqual(["start:first", "start:second", "end:first", "end:second"]);
    }),
  );

  it.effect("continues cleanup after an end Hook is interrupted", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const phase = yield* beginHookPhase(
        plugins("first", "second"),
        () => Effect.void,
        (plugin) =>
          Effect.sync(() => void log.push(plugin.name)).pipe(
            Effect.andThen(plugin.name === "first" ? Effect.interrupt : Effect.void),
          ),
        "end failed",
      );

      expect(Exit.isFailure(yield* Effect.exit(phase.end))).toBe(true);
      yield* phase.cleanup;

      expect(log).toEqual(["first", "second"]);
    }),
  );

  it.effect("cleans up only the prefix whose start Hooks completed", () =>
    Effect.gen(function* () {
      const failure = new Error("start failed");
      const log: Array<string> = [];

      expect(
        yield* Effect.flip(
          beginHookPhase(
            plugins("first", "second", "third"),
            (plugin) =>
              Effect.sync(() => void log.push(`start:${plugin.name}`)).pipe(
                Effect.andThen(plugin.name === "second" ? Effect.fail(failure) : Effect.void),
              ),
            (plugin) => Effect.sync(() => void log.push(`end:${plugin.name}`)),
            "end failed",
          ),
        ),
      ).toBe(failure);
      expect(log).toEqual(["start:first", "start:second", "end:first"]);
    }),
  );

  it.effect("reports the first end Hook error after running later end Hooks", () =>
    Effect.gen(function* () {
      const first = new Error("first");
      const second = new Error("second");
      const log: Array<string> = [];
      const phase = yield* beginHookPhase(
        plugins("first", "second", "third"),
        () => Effect.void,
        (plugin) =>
          Effect.sync(() => void log.push(plugin.name)).pipe(
            Effect.andThen(
              plugin.name === "first"
                ? Effect.fail(first)
                : plugin.name === "second"
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
