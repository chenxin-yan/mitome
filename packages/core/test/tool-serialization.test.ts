import { describe, expect, test } from "bun:test";
import { Effect, Layer, Stream } from "effect";
import { Schema } from "effect";
import { LanguageModel, Response, Tool, Toolkit } from "effect/unstable/ai";
import { createSession, makeModel, type Definition } from "../src/index.js";

describe("createSession Tool serialization", () => {
  test("does not overlap two Tool handlers while model output streams", async () => {
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const log: Array<string> = [];
    let startFirst!: () => void;
    let releaseFirst!: () => void;
    let startPostFirst!: () => void;
    let releasePostFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => (startFirst = resolve));
    const firstReleased = new Promise<void>((resolve) => (releaseFirst = resolve));
    const postFirstStarted = new Promise<void>((resolve) => (startPostFirst = resolve));
    const postFirstReleased = new Promise<void>((resolve) => (releasePostFirst = resolve));
    const first = Tool.make("first", { parameters: Schema.Struct({}), success: Schema.String });
    const second = Tool.make("second", { parameters: Schema.Struct({}), success: Schema.String });
    const model = makeModel(
      Layer.succeed(LanguageModel.LanguageModel, {
        streamText: (options: { readonly toolkit?: Toolkit.WithHandler<any> }) => {
          calls += 1;
          if (calls === 2)
            return Stream.succeed(Response.makePart("text-delta", { id: "second", delta: "done" }));
          const toolCalls = [
            Response.makePart("tool-call", {
              id: "one",
              name: "first",
              params: {},
              providerExecuted: false,
            }),
            Response.makePart("tool-call", {
              id: "two",
              name: "second",
              params: {},
              providerExecuted: false,
            }),
          ];
          const results = Stream.mergeAll({ concurrency: "unbounded" })(
            toolCalls.map((call) =>
              Stream.unwrap(options.toolkit!.handle(call.name, call.params)).pipe(
                Stream.map((result) =>
                  Response.makePart("tool-result", {
                    id: call.id,
                    name: call.name,
                    providerExecuted: false,
                    ...result,
                  }),
                ),
              ),
            ),
          );
          return Stream.concat(
            Stream.fromIterable([
              Response.makePart("text-delta", { id: "first", delta: "working" }),
              ...toolCalls,
            ]),
            results,
          );
        },
      } as LanguageModel.Service),
    );
    const track = (label: string) =>
      Effect.sync(() => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        log.push(label);
        active -= 1;
      });
    const definition: Definition = {
      instructions: "Be concise.",
      model,
      plugins: [
        {
          name: "tools",
          toolkit: Toolkit.make(first, second),
          hooks: {
            preTool: ({ name }) => track(`pre-${name}`),
            postTool: ({ name, result }) => {
              if (name !== "first") return track(`post-${name}`).pipe(Effect.map(() => result));
              return Effect.tryPromise({
                try: async () => {
                  active += 1;
                  maxActive = Math.max(maxActive, active);
                  log.push("post-first-start");
                  startPostFirst();
                  await postFirstReleased;
                  log.push("post-first-end");
                  active -= 1;
                  return result;
                },
                catch: () => new Error("post-first failed"),
              });
            },
          },
          handlers: {
            first: () =>
              Effect.promise(async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                log.push("first-start");
                startFirst();
                await firstReleased;
                log.push("first-end");
                active -= 1;
                return "first";
              }),
            second: () =>
              Effect.promise(async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                log.push("second-run");
                active -= 1;
                return "second";
              }),
          },
        },
      ],
    };

    const turn = Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* createSession(definition);
          return yield* Stream.runCollect(session.prompt("Hi"));
        }),
      ),
    );
    await firstStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).toEqual(["pre-first", "first-start"]);
    expect(maxActive).toBe(1);
    releaseFirst();
    await postFirstStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      expect(log).toEqual(["pre-first", "first-start", "first-end", "post-first-start"]);
      expect(maxActive).toBe(1);
    } finally {
      releasePostFirst();
    }
    const events = await turn;

    expect(log).toEqual([
      "pre-first",
      "first-start",
      "first-end",
      "post-first-start",
      "post-first-end",
      "pre-second",
      "second-run",
      "post-second",
    ]);
    expect(maxActive).toBe(1);
    expect([...events].map((event) => event.type)).toEqual([
      "model-output",
      "tool-call",
      "tool-call",
      "tool-result",
      "tool-result",
      "model-output",
      "response-complete",
    ]);
  });
});
