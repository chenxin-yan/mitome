import { types } from "node:util";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Cause, Effect, Exit, Predicate, Schema } from "effect";
import { LanguageModel, Prompt, type Response, Tool, Toolkit } from "effect/ai";
import { Approver, isPlainData, ModelRequestAccounting, Turn } from "../../src/index.js";
import { localTools, Session, step } from "../../src/kernel.js";
import { call, scriptedModel } from "../support/step.js";
import { recordingTranscript } from "../support/transcript.js";

// The conversation holds plain data, never live objects: a Tool's schema turns a live value into
// data, the kernel checks what reaches the conversation at the door, and a store picks its format.

const encodeMessage = Schema.encodeEffect(Prompt.Message);
const decodeMessage = Schema.decodeUnknownEffect(Prompt.Message);

/** What any store reads back: the encoded form, through a format, decoded again. */
const readBack = (message: Prompt.Message) =>
  Effect.flatMap(encodeMessage(message), (encoded) =>
    decodeMessage(JSON.parse(JSON.stringify(encoded))),
  );

const resultMessage = <A>(value: A) =>
  Prompt.toolMessage({
    content: [
      Prompt.toolResultPart({
        id: "call",
        name: "tool",
        isFailure: false,
        providerExecuted: false,
        result: value,
      }),
    ],
  });

/** A record that comes back to itself. */
interface Loop {
  readonly name: string;
  self?: Loop;
}

/** Values that are not JSON, with what the refusal says is there. */
const liveValues = () => {
  const cycle: Loop = { name: "loop" };
  cycle.self = cycle;
  return [
    ["a Date", { when: new Date(0) }],
    ["NaN", { reading: Number.NaN }],
    ["a Set", { values: new Set(["one"]) }],
    ["a Map", { values: new Map([["one", 1]]) }],
    ["a Point", { at: new (class Point {})() }],
    ["a bigint", { count: 1n }],
    ["a cycle", cycle],
    ["a function", { toJSON: () => "x" }],
  ] as const;
};

/** JSON a getter and a Proxy hand out when read. */
const readOnRequest = () => ({
  getter: {
    get reading() {
      return 1;
    },
  },
  proxied: new Proxy({ kept: ["x"] }, {}),
});

/** A leaf under more levels of records than the stack has frames. */
type Nested<Leaf> = Leaf | { readonly deeper: Nested<Leaf> };
const deeplyNested = <Leaf>(leaf: Leaf) => {
  let nested: Nested<Leaf> = leaf;
  for (let level = 0; level < 100_000; level += 1) {
    nested = { deeper: nested };
  }
  return nested;
};

/** The record under `deeper` levels of `nested`, or `undefined` where it ends sooner. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- walks a value a handler received, whatever its schema decoded
const levelOf = (nested: unknown, deeper: number) => {
  let level = nested;
  for (let index = 0; index < deeper; index += 1) {
    level = Predicate.hasProperty(level, "deeper") ? level.deeper : undefined;
  }
  return level;
};

describe("isPlainData", () => {
  it("is Effect's Schema.Json, as a type guard", () => {
    for (const [, value] of liveValues()) {
      expect(isPlainData(value)).toBe(false);
    }
    const inherited = Object.setPrototypeOf({}, { toJSON: () => "x" });
    const holes: Array<number> = [];
    holes[1] = 1;
    for (const value of [
      undefined,
      Infinity,
      inherited,
      holes,
      [undefined],
      // It does not strip: a field of `undefined` is not JSON.
      { absent: undefined },
    ]) {
      expect(isPlainData(value)).toBe(false);
    }
    const shared = { kept: "x" };
    for (const value of [
      null,
      true,
      0,
      "",
      [1, "two", [null]],
      { a: { b: [shared, shared] }, toJSON: "text" },
      Object.assign(Object.create(null), { bare: 1 }),
      ...Object.values(readOnRequest()),
      deeplyNested("leaf"),
    ]) {
      expect(isPlainData(value)).toBe(true);
    }
    expectTypeOf(isPlainData).parameter(0).toBeUnknown();
    expectTypeOf(isPlainData).guards.toEqualTypeOf<Schema.Json>();
  });
});

describe("a staged Message", () => {
  it.effect(
    "holding a value that is not JSON is refused with a Transcript and without, naming where",
    () =>
      Effect.gen(function* () {
        for (const [found, value] of liveValues()) {
          for (const stored of [undefined, recordingTranscript()]) {
            const session =
              stored === undefined
                ? yield* Session.make({ transcript: "none" })
                : yield* Session.make({ transcript: stored.transcript });
            const exit = yield* Effect.exit(
              session.run(
                Effect.gen(function* () {
                  const turn = yield* Turn;
                  yield* turn.stage(resultMessage(value));
                }),
              ),
            );
            expect(Exit.hasDies(exit)).toBe(true);
            const defect = Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "";
            expect(defect).toContain("staged tool Message");
            expect(defect).toContain("content[0].result");
            expect(defect).toContain(found);
            expect(yield* session.history).toEqual([]);
            expect(stored?.stored.entries.size ?? 0).toBe(0);
          }
        }
      }),
  );

  it.effect("holding JSON behind a getter or a Proxy is kept as a plain copy", () =>
    Effect.gen(function* () {
      const original = readOnRequest();
      const session = yield* Session.make({ transcript: "none" });
      yield* session.run(
        Effect.gen(function* () {
          const turn = yield* Turn;
          yield* turn.stage(resultMessage(original));
        }),
      );
      // Later changes to what was staged reach nothing kept.
      original.proxied.kept.push("later");
      const [kept] = yield* session.history;
      const part = kept?.role === "tool" ? kept.content[0] : undefined;
      const result = part?.type === "tool-result" ? part.result : undefined;
      expect(result).toEqual({ getter: { reading: 1 }, proxied: { kept: ["x"] } });
      const proxied = Predicate.hasProperty(result, "proxied") ? result.proxied : undefined;
      expect(types.isProxy(proxied)).toBe(false);
      const getter = Predicate.hasProperty(result, "getter") ? result.getter : undefined;
      expect(Object.getOwnPropertyDescriptor(getter, "reading")).toMatchObject({ value: 1 });
    }),
  );

  it.effect("holding JSON nested deeper than the stack is kept", () =>
    Effect.gen(function* () {
      const session = yield* Session.make({ transcript: "none" });
      yield* session.run(
        Effect.gen(function* () {
          const turn = yield* Turn;
          yield* turn.stage(resultMessage(deeplyNested("leaf")));
        }),
      );
      expect(yield* session.history).toHaveLength(1);
    }),
  );

  it.effect("holding a value that is not JSON deeper than the stack is refused, naming it", () =>
    Effect.gen(function* () {
      const session = yield* Session.make({ transcript: "none" });
      const exit = yield* Effect.exit(
        session.run(
          Effect.gen(function* () {
            const turn = yield* Turn;
            yield* turn.stage(resultMessage(deeplyNested(new Date(0))));
          }),
        ),
      );
      const defect = Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "";
      expect(defect).toContain("staged tool Message");
      expect(defect).toContain(`content[0].result${".deeper".repeat(100_000)} is a Date`);
      expect(yield* session.history).toEqual([]);
    }),
  );

  it.effect("keeps a field named __proto__ as an own field", () =>
    Effect.gen(function* () {
      const labelled: unknown = JSON.parse('{"__proto__":"label","kept":1}');
      const nested: unknown = JSON.parse('{"__proto__":{"inner":1},"kept":1}');
      const session = yield* Session.make({ transcript: "none" });
      yield* session.run(
        Effect.gen(function* () {
          const turn = yield* Turn;
          yield* turn.stage(resultMessage(labelled), resultMessage(nested));
        }),
      );
      const results = (yield* session.history).map((kept) => {
        const part = kept.role === "tool" ? kept.content[0] : undefined;
        return part?.type === "tool-result" ? part.result : undefined;
      });
      expect(results).toHaveLength(2);
      for (const [result, field] of [
        [results[0], "label"],
        [results[1], { inner: 1 }],
      ] as const) {
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
        expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toEqual(field);
        expect(Object.getOwnPropertyDescriptor(result, "kept")?.value).toBe(1);
        expect(isPlainData(result)).toBe(true);
      }
    }),
  );

  it.effect("keeps a file part's bytes", () =>
    Effect.gen(function* () {
      for (const data of [new Uint8Array([1, 2, 3]), Buffer.from([1, 2, 3])]) {
        const session = yield* Session.make({ transcript: "none" });
        yield* session.run(
          Effect.gen(function* () {
            const turn = yield* Turn;
            yield* turn.stage(
              Prompt.userMessage({ content: [Prompt.filePart({ mediaType: "text/plain", data })] }),
            );
          }),
        );
        expect(yield* session.history).toHaveLength(1);
      }
    }),
  );

  it.effect("drops a field of undefined and keeps what a store reads back", () =>
    Effect.gen(function* () {
      const { transcript, stored } = recordingTranscript();
      const session = yield* Session.make({ transcript });
      yield* session.run(
        Effect.gen(function* () {
          const turn = yield* Turn;
          yield* turn.stage(
            resultMessage({ kept: [1, { deep: "x", gone: undefined }], gone: undefined }),
          );
        }),
      );
      const [kept] = yield* session.history;
      if (kept === undefined) {
        throw new Error("expected a kept Message");
      }
      expect(kept).toEqual(yield* readBack(kept));
      expect(kept).toEqual(resultMessage({ kept: [1, { deep: "x" }] }));
      expect([...stored.entries.values()][0]?.messages).toEqual([kept]);
    }),
  );

  it.effect("keeps negative zero as zero, which is what a store reads back", () =>
    Effect.gen(function* () {
      const session = yield* Session.make({ transcript: "none" });
      yield* session.run(
        Effect.gen(function* () {
          const turn = yield* Turn;
          yield* turn.stage(resultMessage({ reading: -0 }));
        }),
      );
      const [kept] = yield* session.history;
      const part = kept?.role === "tool" ? kept.content[0] : undefined;
      const result = part?.type === "tool-result" ? part.result : undefined;
      expect(
        Object.is(Predicate.hasProperty(result, "reading") ? result.reading : undefined, 0),
      ).toBe(true);
    }),
  );
});

describe("a Model response holding a live value", () => {
  const Loose = Tool.make("loose", {
    parameters: Schema.Struct({ value: Schema.Any }),
    success: Schema.String,
  });

  it.effect(
    "fails the Step as malformed, naming where, before any policy, Approver or Tool runs",
    () =>
      Effect.gen(function* () {
        for (const [found, value] of liveValues()) {
          const seen: Array<string> = [];
          const program = Effect.gen(function* () {
            const tools = yield* localTools(Toolkit.make(Loose), {
              loose: () => Effect.sync(() => (seen.push("handler"), "ok")),
            });
            return yield* step({
              tools,
              policy: () => Effect.sync(() => (seen.push("policy"), "ask" as const)),
            }).pipe(
              Effect.provideService(Approver, {
                decide: () => Effect.sync(() => (seen.push("approver"), "allow" as const)),
              }),
            );
          });
          const parts: ReadonlyArray<Response.PartEncoded> = [
            { type: "tool-call", id: "c1", name: "loose", params: { value } },
          ];
          const session = yield* Session.make({ transcript: "none" });
          const exit = yield* Effect.exit(
            session.run(program.pipe(Effect.provide(scriptedModel([parts], [])))),
          );
          const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
          expect(failure).toMatchObject({
            _tag: "StepProtocolError",
            reason: "malformed-response",
          });
          expect(String(failure)).toContain(`${found} at content[0].params.value`);
          expect(seen).toEqual([]);
        }
      }),
  );

  it.effect("fails the Step as malformed when the value is deeper than the stack", () =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const tools = yield* localTools(Toolkit.make(Loose), {
          loose: () => Effect.succeed("ok"),
        });
        return yield* step({ tools });
      });
      const parts: ReadonlyArray<Response.PartEncoded> = [
        { type: "tool-call", id: "c1", name: "loose", params: { value: deeplyNested(1n) } },
      ];
      const session = yield* Session.make({ transcript: "none" });
      const exit = yield* Effect.exit(
        session.run(program.pipe(Effect.provide(scriptedModel([parts], [])))),
      );
      const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      expect(failure).toMatchObject({ _tag: "StepProtocolError", reason: "malformed-response" });
      expect(String(failure)).toContain(
        `a bigint at content[0].params.value${".deeper".repeat(100_000)}`,
      );
    }),
  );
});

describe("Tool Call parameters nested deeper than the stack", () => {
  it.effect("are dispatched, and the handler receives them frozen", () =>
    Effect.gen(function* () {
      const Loose = Tool.make("loose", {
        parameters: Schema.Struct({ value: Schema.Any }),
        success: Schema.String,
      });
      const received: Array<unknown> = [];
      const program = Effect.gen(function* () {
        const tools = yield* localTools(Toolkit.make(Loose), {
          loose: ({ value }) => Effect.sync(() => (received.push(value), "ok")),
        });
        return yield* step({ tools });
      });
      const parts: ReadonlyArray<Response.PartEncoded> = [
        { type: "tool-call", id: "c1", name: "loose", params: { value: deeplyNested("leaf") } },
      ];
      const session = yield* Session.make({ transcript: "none" });
      yield* session.run(program.pipe(Effect.provide(scriptedModel([parts], []))));
      expect(received).toHaveLength(1);
      expect(Object.isFrozen(received[0])).toBe(true);
      const deepest = levelOf(received[0], 99_999);
      expect(Predicate.hasProperty(deepest, "deeper") && deepest.deeper).toBe("leaf");
      expect(Object.isFrozen(deepest)).toBe(true);
    }),
  );
});

describe("Tool Call parameters with an absent field", () => {
  it.effect("reach the Approver, the handler and the conversation as the same value", () =>
    Effect.gen(function* () {
      const Loose = Tool.make("loose", {
        parameters: Schema.Struct({ value: Schema.Any }),
        success: Schema.String,
      });
      const shown: Array<unknown> = [];
      const received: Array<unknown> = [];
      // The Model's own object, which its owner changes while the Tool runs.
      const retained = { kept: 1, label: undefined };
      const program = Effect.gen(function* () {
        const tools = yield* localTools(Toolkit.make(Loose), {
          loose: ({ value }) =>
            Effect.sync(() => {
              received.push(value);
              retained.kept = 2;
              return "ok";
            }),
        });
        return yield* step({ tools, policy: () => Effect.succeed("ask" as const) }).pipe(
          Effect.provideService(Approver, {
            decide: ({ params }) => Effect.sync(() => (shown.push(params), "allow" as const)),
          }),
        );
      });
      const parts: ReadonlyArray<Response.PartEncoded> = [
        {
          type: "tool-call",
          id: "c1",
          name: "loose",
          params: { value: retained },
        },
      ];
      const session = yield* Session.make({ transcript: "none" });
      yield* session.run(program.pipe(Effect.provide(scriptedModel([parts], []))));
      expect(Schema.is(Schema.Json)(shown[0])).toBe(true);
      expect(shown[0]).toEqual({ value: { kept: 1 } });
      expect(Object.keys(Object(received[0]))).toEqual(["kept"]);
      const call = (yield* session.history)[0]?.content[0];
      expect(Predicate.hasProperty(call, "params") ? call.params : undefined).toEqual({
        value: { kept: 1 },
      });
    }),
  );
});

describe("a Tool result", () => {
  const run = <A, E>(
    program: Effect.Effect<A, E, Turn | LanguageModel.LanguageModel | ModelRequestAccounting>,
    parts: ReadonlyArray<Response.PartEncoded>,
  ) =>
    Effect.gen(function* () {
      const session = yield* Session.make({ transcript: "none" });
      const exit = yield* Effect.exit(
        session.run(program.pipe(Effect.provide(scriptedModel([parts], [])))),
      );
      return { exit, history: yield* session.history };
    });

  it.effect("whose encoded form is a live object is a defect naming the Tool", () =>
    Effect.gen(function* () {
      // `Schema.Any` encodes nothing, so the live Date would reach the conversation as it is.
      const Loose = Tool.make("clock", {
        parameters: Schema.Struct({ key: Schema.String }),
        success: Schema.Any,
      });
      const program = Effect.gen(function* () {
        const tools = yield* localTools(Toolkit.make(Loose), {
          clock: () => Effect.succeed({ now: new Date(0) }),
        });
        return yield* step({ tools });
      });
      const { exit, history } = yield* run(program, [call("c1", "clock")]);
      expect(Exit.hasDies(exit)).toBe(true);
      const defect = Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "";
      expect(defect).toContain('Tool "clock"');
      expect(defect).toContain("a Date");
      expect(history).toEqual([]);
    }),
  );

  it.effect("whose schema encodes a live value keeps the live one for the program", () =>
    Effect.gen(function* () {
      const Clock = Tool.make("clock", {
        parameters: Schema.Struct({ key: Schema.String }),
        success: Schema.Date,
      });
      const when = new Date(0);
      const program = Effect.gen(function* () {
        const tools = yield* localTools(Toolkit.make(Clock), {
          clock: () => Effect.succeed(when),
        });
        return yield* step({ tools });
      });
      const { exit, history } = yield* run(program, [call("c1", "clock")]);
      const result = yield* exit;
      if (!Predicate.isTagged(result, "Complete")) {
        throw new Error("expected a complete Step");
      }
      expect(result.results[0]?.result).toBe(when);
      const tool = history.find((message) => message.role === "tool");
      const part = tool?.role === "tool" ? tool.content[0] : undefined;
      expect(part?.type === "tool-result" && part.result).toBe(when.toISOString());
    }),
  );

  it.effect("is kept as the copy that was checked, made once", () =>
    Effect.gen(function* () {
      const Reading = Tool.make("reading", {
        parameters: Schema.Struct({ key: Schema.String }),
        success: Schema.Any,
      });
      let reads = 0;
      const program = Effect.gen(function* () {
        const tools = yield* localTools(Toolkit.make(Reading), {
          reading: () =>
            Effect.succeed({
              get reading() {
                return (reads += 1);
              },
            }),
        });
        return yield* step({ tools });
      });
      const { exit, history } = yield* run(program, [call("c1", "reading")]);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(reads).toBe(1);
      const tool = history.find((message) => message.role === "tool");
      const part = tool?.role === "tool" ? tool.content[0] : undefined;
      expect(part?.type === "tool-result" && part.result).toEqual({ reading: 1 });
    }),
  );
});
