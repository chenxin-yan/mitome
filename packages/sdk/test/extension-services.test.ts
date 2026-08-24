import { describe, expect, test } from "vitest";
import { Context, Layer, Stream } from "effect";
import { Response } from "effect/unstable/ai";
import { defineExtension as defineEffectExtension } from "../src/effect.js";
import { defineAgent, defineExtension, tool, withSession } from "../src/index.js";
import { jsonStringSchema, makeTestProvider, makeToolModel, stringSchema } from "./provider.js";

const textModel = () =>
  makeTestProvider(() =>
    Stream.succeed(Response.makePart("text-delta", { id: "done", delta: "done" })),
  );

describe("@mitome/sdk Extension Provided Services", () => {
  test("consumes an Effect Extension's Provided Service from an SDK Tool handler and Hook", async () => {
    class Counter extends Context.Service<Counter, { count: number }>()("test/Counter") {}
    const counterLayer = Layer.succeed(Counter, { count: 0 });
    const provider = defineEffectExtension<
      typeof counterLayer,
      readonly [],
      readonly [typeof Counter]
    >({
      name: "effect-provider",
      resource: counterLayer,
      provides: [Counter],
    });
    const observed: Array<number> = [];
    const dependent = defineExtension({
      name: "sdk-dependent",
      dependencies: [provider],
      hooks: {
        sessionStart: async ({ getService }) => void observed.push(getService(Counter).count),
      },
      tools: [
        tool({
          name: "increment",
          dependencies: [Counter],
          inputSchema: jsonStringSchema,
          outputSchema: stringSchema,
          handler: async (_input, { getService }) => {
            const counter = getService(Counter);
            counter.count += 1;
            return String(counter.count);
          },
        }),
      ],
    });
    const fixture = makeToolModel("increment");

    const events = await withSession(
      defineAgent({
        providers: [fixture.provider],
        model: "test/default",
        extensions: [dependent],
      }),
      (session) => Array.fromAsync(session.prompt("increment")),
    );

    expect(events).toContainEqual({
      type: "tool-result",
      id: "call-1",
      name: "increment",
      result: "1",
      isFailure: false,
    });
    expect(observed).toEqual([0]);
  });

  test("publishes an SDK service to an Effect Extension", async () => {
    class Greeting extends Context.Service<Greeting, { readonly text: string }>()(
      "test/Greeting",
    ) {}
    const provider = defineExtension({
      name: "sdk-provider",
      provides: [Greeting],
      tools: [],
      setup: async () => ({ text: "hello from sdk" }),
    });
    const observed: Array<string> = [];
    const dependent = defineEffectExtension({
      name: "effect-dependent",
      dependencies: [provider],
      hooks: {
        sessionStart: Greeting.useSync(({ text }) => void observed.push(text)),
      },
    });

    await withSession(
      defineAgent({ providers: [textModel()], model: "test/default", extensions: [dependent] }),
      async () => undefined,
    );

    expect(observed).toEqual(["hello from sdk"]);
  });
});
