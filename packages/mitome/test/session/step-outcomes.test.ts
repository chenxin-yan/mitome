import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { localTools, Session, step } from "../../src/kernel.js";
import { call, scriptedModel } from "../support/step.js";
import { recordingTranscript } from "../support/transcript.js";

// A Step's local Tool results, as the program reads them from the Step it ran.

describe("Step Tool results", () => {
  it.effect(
    "returns return-mode failure data, and no Tool result of an incomplete generation",
    () =>
      Effect.gen(function* () {
        const Soft = Tool.make("soft", {
          parameters: Schema.Struct({ key: Schema.String }),
          success: Schema.String,
          failureMode: "return",
        });
        const recorded = yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* Session.make({ transcript: "none" });
            const tools = yield* localTools(Toolkit.make(Soft), {
              soft: ({ key }) => Effect.succeed(key),
            });
            return yield* session.run(
              Effect.gen(function* () {
                const denied = yield* step({ tools, policy: () => Effect.succeed("deny") });
                // Incomplete: nothing dispatched, no result.
                const incomplete = yield* step({ tools });
                return [
                  ...(Predicate.isTagged(denied, "Complete") ? denied.results : []),
                  ...(Predicate.isTagged(incomplete, "Complete") ? incomplete.results : []),
                ];
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

  it.effect("returns the native result while a Transcript stores only encoded data", () =>
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
          const session = yield* Session.make({
            transcript: recordingTranscript((entry) =>
              Effect.sync(() => void (saved = JSON.stringify(entry.messages))),
            ).transcript,
          });
          const tools = yield* localTools(OwnedKit, { owned: () => Effect.succeed(native) });
          const result = yield* session.run(
            step({ tools }).pipe(Effect.provide(scriptedModel([[call("a", "owned")]], []))),
          );
          return Predicate.isTagged(result, "Complete") ? result.results : [];
        }),
      );
      expect(owned[0]?.result).toBe(native);
      expect(saved).toContain("encoded");
      expect(saved).not.toContain("owner-only-marker");
    }),
  );
});
