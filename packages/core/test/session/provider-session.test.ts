import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/unstable/ai";
import { createSession, defineAgent, makeProvider } from "../../src/index.js";
import { testLanguageModel } from "../support/provider.js";

const textLayer = (output: string, capture: (prompt: Prompt.Prompt) => void = () => undefined) =>
  Layer.succeed(
    LanguageModel.LanguageModel,
    testLanguageModel(({ prompt }) => {
      capture(prompt);
      return Stream.succeed(Response.makePart("text-delta", { id: output, delta: output }));
    }),
  );

describe("Provider-backed Sessions", () => {
  it.effect("uses the Default Model and a per-Turn override with shared history", () =>
    Effect.gen(function* () {
      const prompts: Array<Prompt.Prompt> = [];
      const first = makeProvider("first", ["default"] as const, undefined, (modelId) =>
        textLayer(`first/${modelId}`, (prompt) => prompts.push(prompt)),
      );
      const second = makeProvider("second", ["alternate"] as const, undefined, (modelId) =>
        textLayer(`second/${modelId}`, (prompt) => prompts.push(prompt)),
      );
      const session = yield* createSession(
        defineAgent({
          providers: [first, second] as const,
          model: "first/default",
          extensions: [],
        }),
      );

      const defaultEvents = yield* Stream.runCollect(session.prompt("one"));
      const overrideEvents = yield* Stream.runCollect(
        session.prompt("two", { model: "second/private/path" }),
      );

      expect(defaultEvents[0]).toEqual({ type: "model-output", text: "first/default" });
      expect(overrideEvents[0]).toEqual({
        type: "model-output",
        text: "second/private/path",
      });
      expect(prompts[1]?.content.map((message) => message.role)).toEqual(["user", "user"]);
    }),
  );

  it.effect("rejects an unregistered selection before Turn Hooks and remains reusable", () =>
    Effect.gen(function* () {
      let turnStarts = 0;
      const provider = makeProvider("registered", [] as const, undefined, (modelId) =>
        textLayer(modelId),
      );
      const session = yield* createSession(
        defineAgent({
          providers: [provider] as const,
          model: "registered/default",
          extensions: [
            {
              name: "hooks",
              hooks: {
                turnStart: () => Effect.sync(() => void (turnStarts += 1)),
              },
            },
          ],
        }),
      );

      const error = yield* Effect.flip(
        Stream.runDrain(session.prompt("bad", { model: "missing/model" } as never)),
      );

      expect(error).toMatchObject({
        _tag: "TurnError",
        message: "Unregistered Provider id: missing",
      });
      expect(turnStarts).toBe(0);
      expect(session.history()).toEqual([]);

      yield* Stream.runDrain(session.prompt("good"));
      expect(turnStarts).toBe(1);
      expect(session.history().map((message) => message.role)).toEqual(["user"]);
    }),
  );

  it.effect("pins one Model selection through Tool continuation Steps", () =>
    Effect.gen(function* () {
      const selected: Array<string> = [];
      let calls = 0;
      const provider = makeProvider("tools", [] as const, undefined, (modelId) => {
        selected.push(modelId);
        return Layer.succeed(
          LanguageModel.LanguageModel,
          testLanguageModel((options) => {
            calls += 1;
            if (calls === 2) {
              return Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" }));
            }
            const call = Response.makePart("tool-call", {
              id: "call",
              name: "echo",
              params: {},
              providerExecuted: false,
            });
            return Stream.concat(
              Stream.succeed(call),
              Stream.unwrap(
                options.toolkit!.handle("echo", {}).pipe(
                  Effect.map((results) =>
                    Stream.map(results, (result) =>
                      Response.makePart("tool-result", {
                        id: call.id,
                        name: call.name,
                        providerExecuted: false,
                        ...result,
                      }),
                    ),
                  ),
                ),
              ),
            );
          }),
        );
      });
      const echo = Tool.make("echo", { success: Schema.String });
      const session = yield* createSession(
        defineAgent({
          providers: [provider] as const,
          model: "tools/default",
          extensions: [
            {
              name: "echo",
              toolkit: Toolkit.make(echo),
              handlers: { echo: () => Effect.succeed("ok") },
            },
          ],
        }),
      );

      yield* Stream.runDrain(session.prompt("go", { model: "tools/selected" }));

      expect(calls).toBe(2);
      expect(selected).toEqual(["selected"]);
    }),
  );

  it.effect("provisions lazily, caches by full identifier, and releases with the Session", () =>
    Effect.gen(function* () {
      const provisioned: Array<string> = [];
      let builds = 0;
      let releases = 0;
      const counting = makeProvider("counting", [] as const, undefined, (modelId) => {
        provisioned.push(modelId);
        return Layer.effect(
          LanguageModel.LanguageModel,
          Effect.acquireRelease(
            Effect.sync(() => {
              builds += 1;
              return testLanguageModel(() =>
                Stream.succeed(Response.makePart("text-delta", { id: modelId, delta: modelId })),
              );
            }),
            () => Effect.sync(() => void (releases += 1)),
          ),
        );
      });
      const unused = makeProvider("unused", [] as const, undefined, () => {
        throw new Error("unused Provider was provisioned");
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession(
            defineAgent({
              providers: [unused, counting] as const,
              model: "counting/one",
              extensions: [],
            }),
          );
          expect(builds).toBe(0);
          yield* Stream.runDrain(session.prompt("first"));
          yield* Stream.runDrain(session.prompt("again"));
          yield* Stream.runDrain(session.prompt("other", { model: "counting/two" }));
          expect(provisioned).toEqual(["one", "two"]);
          expect(builds).toBe(2);
          expect(releases).toBe(0);
        }),
      );

      expect(releases).toBe(2);
    }),
  );
});
