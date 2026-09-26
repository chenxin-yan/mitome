// Runtime observations for fixture.ts on Effect rc.117 (`bun checks.ts`, expected exit 0).
import assert from "node:assert/strict";
import { Cause, Effect, Exit, Layer, Option, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import * as F from "./fixture.ts";

const services = (log: Array<string>, fail: boolean) =>
  Layer.mergeAll(
    Layer.succeed(F.Decoder, { parse: Number }),
    Layer.succeed(F.Encoder, { render: (value: number) => `rendered:${value}` }),
    Layer.succeed(F.Invocation, { label: "invocation" }),
    Layer.succeed(F.Infrastructure, { fail, log }),
  );
const withModel = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(F.model, (model) =>
    Effect.provideService(effect, LanguageModel.LanguageModel, model),
  );
const run = <A, E>(
  effect: Effect.Effect<A, E, F.Decoder | F.Encoder | F.Invocation | F.Infrastructure>,
  log: Array<string>,
  fail = false,
) => Effect.runPromise(Effect.exit(effect.pipe(Effect.provide(services(log, fail)))));
const check = async (name: string, body: () => Promise<void>) => {
  await body();
  console.log(`PASS ${name}`);
};
const rendered42 = {
  result: 42,
  encodedResult: "rendered:42",
  isFailure: false,
  preliminary: false,
};

await check(
  "serviceful input decoding and output encoding, full outer handle + drain",
  async () => {
    const log: Array<string> = [];
    F.calls.length = 0;
    const exit = await run(F.convertAll("21").pipe(Effect.provide(F.handlersLayer)), log);
    assert(Exit.isSuccess(exit));
    assert.deepEqual(exit.value, [rendered42]);
    assert.deepEqual(F.calls, ["invocation"]);
    assert.deepEqual(log, ["acquire", "release"]);
  },
);

await check("serviceful output encoding and handler dependency (untransformed input)", async () => {
  const exit = await run(F.renderAll(21).pipe(Effect.provide(F.handlersLayer)), []);
  assert(Exit.isSuccess(exit));
  assert.deepEqual(exit.value, [rendered42]);
});

await check("error mode keeps the typed handler failure a failure", async () => {
  const exit = await run(F.renderAll(-1).pipe(Effect.provide(F.handlersLayer)), []);
  assert(Exit.isFailure(exit));
  assert.deepEqual(Cause.findErrorOption(exit.cause), Option.some("user-failed"));
});

await check("return mode reports the handler failure as a failure value, not success", async () => {
  const exit = await run(F.renderReturnedAll(-1).pipe(Effect.provide(F.handlersLayer)), []);
  assert(Exit.isSuccess(exit));
  assert.deepEqual(exit.value, [
    {
      result: "user-failed",
      encodedResult: "user-failed",
      isFailure: true,
      failureOrigin: "handler",
      preliminary: false,
    },
  ]);
});

await check(
  "failed Layer acquisition unwinds its resource and never enters a handler",
  async () => {
    const log: Array<string> = [];
    F.calls.length = 0;
    const exit = await run(F.renderAll(21).pipe(Effect.provide(F.handlersLayer)), log, true);
    assert(Exit.isFailure(exit));
    assert(Option.getOrThrow(Cause.findErrorOption(exit.cause)) instanceof F.BuildFailed);
    assert.deepEqual(log, ["acquire", "release"]);
    assert.deepEqual(F.calls, []);
  },
);

await check(
  "disabled resolution returns ENCODED params and needs no undeclared Decoder",
  async () => {
    // Only LanguageModel is provided, matching the declared services (types.ts).
    const exit = await Effect.runPromise(Effect.exit(withModel(F.generate)));
    assert(Exit.isSuccess(exit));
    assert.deepEqual(
      exit.value.toolCalls.map((call) => call.params),
      [{ n: "21" }],
    );
  },
);

await check(
  "controlled dispatch of the generated call decodes once and runs the handler once",
  async () => {
    F.calls.length = 0;
    const exit = await run(withModel(F.dispatch).pipe(Effect.provide(F.handlersLayer)), []);
    assert(Exit.isSuccess(exit));
    assert.deepEqual(exit.value, { params: [{ n: "21" }], results: [rendered42] });
    assert.deepEqual(F.calls, ["invocation"]);
  },
);

await check("native #8526 counterexample: Stream-only Decoder compiles but defects", async () => {
  const split = F.convertOuterNative.pipe(
    Effect.flatMap((stream) =>
      Stream.runCollect(stream).pipe(Effect.provideService(F.Decoder, { parse: Number })),
    ),
    Effect.provide(F.handlersLayer),
  );
  const exit = await Effect.runPromise(
    Effect.exit(
      split.pipe(
        Effect.provideService(F.Encoder, { render: String }),
        Effect.provideService(F.Invocation, { label: "invocation" }),
        Effect.provideService(F.Infrastructure, { fail: false, log: [] }),
      ),
    ),
  );
  assert(Exit.isFailure(exit));
  assert(Cause.hasDies(exit.cause));
  assert.match(Cause.pretty(exit.cause), /Service not found: native-baseline\/Decoder/);
});

await check(
  "workaround candidate: outer-provided Decoder decodes before the Stream exists",
  async () => {
    F.calls.length = 0;
    const split = F.convertOuterDeclared.pipe(
      Effect.provideService(F.Decoder, { parse: () => 5 }),
      Effect.flatMap((stream) =>
        // A different Stream-phase Decoder proves which phase decoded the parameters.
        Stream.runCollect(stream).pipe(Effect.provideService(F.Decoder, { parse: () => 99 })),
      ),
      Effect.provide(F.handlersLayer),
    );
    const exit = await run(split, []);
    assert(Exit.isSuccess(exit));
    assert.deepEqual(exit.value, [
      { result: 10, encodedResult: "rendered:10", isFailure: false, preliminary: false },
    ]);
    assert.deepEqual(F.calls, ["invocation"]);
  },
);
