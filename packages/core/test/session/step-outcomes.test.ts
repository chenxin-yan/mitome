import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Ref, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import {
  firstPartyExecutionLimits as limits,
  localTools,
  makeSession,
  SessionReleasedError,
  step,
  toolOutcomes,
  Turn,
} from "../../src/index.js";
import { call, scriptedModel, text } from "../support/step.js";

// Earlier Tool outcomes stay on the Turn's execution record after a later call fails (#180 story
// 26), readable through the registration that produced them while the Session lives.

class Quota extends Schema.TaggedError<Quota>()("Quota", {}) {}
const Write = Tool.make("write", {
  parameters: Schema.Struct({ key: Schema.String }),
  success: Schema.String,
  failure: Quota,
});
const Other = Tool.make("other", {
  parameters: Schema.Struct({ key: Schema.String }),
  success: Schema.Finite,
});
const Kit = Toolkit.make(Write);
const OtherKit = Toolkit.make(Other);

describe("recorded Tool outcomes", () => {
  it.effect("keeps earlier outcomes after a later Tool fails, with its failure unchanged", () =>
    Effect.gen(function* () {
      const failure = new Quota();
      const captured = yield* Ref.make<Turn["Service"] | undefined>(undefined);
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({ persistence: "none", limits });
          const tools = yield* localTools(Kit, {
            write: ({ key }) =>
              key === "quota" ? Effect.fail(failure) : Effect.succeed(`w-${key}`),
          });
          const others = yield* localTools(OtherKit, { other: () => Effect.succeed(1) });
          const program = Effect.gen(function* () {
            yield* Ref.set(captured, yield* Turn);
            // First Step completes one call; the second completes one and fails at the next.
            yield* step({ tools });
            const error = yield* Effect.flip(step({ tools }));
            const earlier = yield* toolOutcomes(tools);
            const foreign = yield* toolOutcomes(others);
            return { error, earlier, foreign };
          }).pipe(
            Effect.provide(
              scriptedModel(
                [
                  [call("a", "write")],
                  [call("b", "write"), call("quota", "write"), call("c", "write")],
                ],
                [],
              ),
            ),
          );
          const inTurn = yield* session.run(program);
          // A failing Turn keeps its native failure, and its outcomes stay readable afterwards.
          const failed = yield* Effect.exit(
            session.run(
              Effect.gen(function* () {
                yield* Ref.set(captured, yield* Turn);
                return yield* step({ tools });
              }).pipe(
                Effect.provide(scriptedModel([[call("d", "write"), call("quota", "write")]], [])),
              ),
            ),
          );
          const stale = yield* Ref.get(captured);
          const afterTurn =
            stale === undefined
              ? []
              : yield* toolOutcomes(tools).pipe(Effect.provideService(Turn, stale));
          return { inTurn, failed, afterTurn, stale, tools };
        }),
      );
      expect(outcome.inTurn.error).toBe(failure);
      expect(outcome.inTurn.earlier.map((part) => [part.id, part.result, part.isFailure])).toEqual([
        ["a", "w-a", false],
        ["b", "w-b", false],
      ]);
      expect(outcome.inTurn.foreign).toEqual([]);
      expect(Exit.isFailure(outcome.failed)).toBe(true);
      if (Exit.isFailure(outcome.failed)) {
        expect(Cause.squash(outcome.failed.cause)).toBe(failure);
      }
      expect(outcome.afterTurn.map((part) => part.id)).toEqual(["d"]);
      // After release the record is gone and reads fail.
      const released = yield* Effect.flip(
        outcome.stale === undefined
          ? Effect.fail(new SessionReleasedError())
          : toolOutcomes(outcome.tools).pipe(Effect.provideService(Turn, outcome.stale)),
      );
      expect(released).toBeInstanceOf(SessionReleasedError);
    }),
  );

  it.effect(
    "records return-mode failure data but no Tool of an incomplete or failed generation",
    () =>
      Effect.gen(function* () {
        const Soft = Tool.make("soft", {
          parameters: Schema.Struct({ key: Schema.String }),
          success: Schema.String,
          failureMode: "return",
        });
        const recorded = yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* makeSession({ persistence: "none", limits });
            const tools = yield* localTools(Toolkit.make(Soft), {
              soft: ({ key }) => Effect.succeed(key),
            });
            return yield* session.run(
              Effect.gen(function* () {
                yield* step({ tools, policy: () => Effect.succeed("deny") });
                // Incomplete: nothing dispatched, nothing recorded.
                yield* step({ tools });
                return yield* toolOutcomes(tools);
              }).pipe(
                Effect.provide(
                  scriptedModel(
                    [
                      [call("x", "soft")],
                      [
                        call("y", "soft"),
                        {
                          type: "finish",
                          reason: "length",
                          usage: { inputTokens: {}, outputTokens: {} },
                        },
                      ],
                      [text("z")],
                    ],
                    [],
                  ),
                ),
              ),
            );
          }),
        );
        expect(recorded.map((part) => [part.id, part.isFailure])).toEqual([["x", true]]);
      }),
  );

  it.effect("keeps the native outcome owner-local while a store saves only encoded data", () =>
    Effect.gen(function* () {
      class Native {
        readonly marker = "owner-only-marker";
        constructor(readonly value: string) {}
      }
      const Owned = Tool.make("owned", {
        parameters: Schema.Struct({ key: Schema.String }),
        success: Schema.Struct({ value: Schema.String }),
      });
      const OwnedKit = Toolkit.make(Owned);
      const native = new Native("encoded");
      let saved = "";
      const owned = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeSession({
            limits,
            persistence: {
              save: (history) => Effect.sync(() => void (saved = JSON.stringify(history))),
            },
          });
          const tools = yield* localTools(OwnedKit, { owned: () => Effect.succeed(native) });
          const turn = yield* session.run(
            Effect.gen(function* () {
              yield* step({ tools });
              return yield* Turn;
            }).pipe(Effect.provide(scriptedModel([[call("a", "owned")]], []))),
          );
          const records = yield* toolOutcomes(tools).pipe(Effect.provideService(Turn, turn));
          expect(records[0]?.result).toBe(native);
          expect(saved).toContain("encoded");
          expect(saved).not.toContain("owner-only-marker");
          return { tools, turn };
        }),
      );
      const closed = yield* Effect.flip(
        toolOutcomes(owned.tools).pipe(Effect.provideService(Turn, owned.turn)),
      );
      expect(closed).toBeInstanceOf(SessionReleasedError);
    }),
  );
});
