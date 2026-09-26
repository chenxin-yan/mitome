// Native Tool controls for Effect 4.0.0-rc.117 (#181). Scratch qualification declarations
// only, not Mitome exports. Grounded in rc.117 `Tool.ts`, `Toolkit.ts`, `LanguageModel.ts`
// and `SchemaGetter.ts`; no casts, package patches or private internals.
import { Context, Effect, Schema, SchemaGetter, Stream } from "effect";
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai";
import type { AiError, Response } from "effect/unstable/ai";

export class Decoder extends Context.Service<
  Decoder,
  { readonly parse: (text: string) => number }
>()("native-baseline/Decoder") {}
export class Encoder extends Context.Service<
  Encoder,
  { readonly render: (value: number) => string }
>()("native-baseline/Encoder") {}
export class Invocation extends Context.Service<Invocation, { readonly label: string }>()(
  "native-baseline/Invocation",
) {}
export class Infrastructure extends Context.Service<
  Infrastructure,
  { readonly fail: boolean; readonly log: Array<string> }
>()("native-baseline/Infrastructure") {}
export class BuildFailed extends Schema.TaggedError<BuildFailed>()("BuildFailed", {}) {}

// Encoded string -> number, decoding requires Decoder.
const DecodedNumber = Schema.String.pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transformEffect((text: string) =>
      Effect.map(Decoder, (decoder) => decoder.parse(text)),
    ),
    encode: SchemaGetter.transform(String),
  }),
);
// Handler number -> encoded string, encoding requires Encoder.
const EncodedResult = Schema.String.pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transform(Number),
    encode: SchemaGetter.transformEffect((value: number) =>
      Effect.map(Encoder, (encoder) => encoder.render(value)),
    ),
  }),
);
const UserFailed = Schema.Literal("user-failed");

// Transforming, serviceful input and output schemas.
export const convert = Tool.make("Convert", {
  parameters: Schema.Struct({ n: DecodedNumber }),
  success: EncodedResult,
  failure: UserFailed,
  dependencies: [Invocation],
});
export const render = Tool.make("Render", {
  parameters: Schema.Struct({ n: Schema.Number }),
  success: EncodedResult,
  failure: UserFailed,
  dependencies: [Invocation],
});
export const renderReturned = Tool.make("RenderReturned", {
  parameters: Schema.Struct({ n: Schema.Number }),
  success: EncodedResult,
  failure: UserFailed,
  failureMode: "return",
  dependencies: [Invocation],
});
export const kit = Toolkit.make(convert, render, renderReturned);

export const calls: Array<string> = [];
const double = (n: number) =>
  Effect.gen(function* () {
    calls.push((yield* Invocation).label);
    if (n < 0) return yield* Effect.fail("user-failed" as const);
    return n * 2;
  });

// Fallible, scoped acquisition: the acquired resource must unwind if building fails.
export const builder = Effect.gen(function* () {
  const infrastructure = yield* Infrastructure;
  yield* Effect.acquireRelease(
    Effect.sync(() => infrastructure.log.push("acquire")),
    () => Effect.sync(() => infrastructure.log.push("release")),
  );
  if (infrastructure.fail) return yield* new BuildFailed();
  return kit.of({
    Convert: ({ n }) => double(n),
    Render: ({ n }) => double(n),
    RenderReturned: ({ n }) => double(n),
  });
});
export const handlersLayer = kit.toLayer(builder);

// Native whole operation: outer `handle` Effect plus complete Stream drain, provided together.
export const convertAll = (n: string) =>
  Effect.gen(function* () {
    const handlers = yield* kit;
    return yield* Stream.runCollect(yield* handlers.handle("Convert", { n }, "convert"));
  });
export const renderAll = (n: number) =>
  Effect.gen(function* () {
    const handlers = yield* kit;
    return yield* Stream.runCollect(yield* handlers.handle("Render", { n }, "render"));
  });
export const renderReturnedAll = (n: number) =>
  Effect.gen(function* () {
    const handlers = yield* kit;
    return yield* Stream.runCollect(
      yield* handlers.handle("RenderReturned", { n }, "render-returned"),
    );
  });

// Phase-split use of native rc.117 `handle`: the outer Effect decodes parameters but declares
// no services, and the return-mode Stream declares no errors (upstream #8526/#8527).
export const convertOuterNative = Effect.gen(function* () {
  const handlers = yield* kit;
  return yield* handlers.handle("Convert", { n: "21" }, "outer");
});
export const renderReturnedStreamNative = Effect.gen(function* () {
  const handlers = yield* kit;
  return yield* handlers.handle("RenderReturned", { n: 1 }, "stream");
});

// TODO(effect-upgrade): delete `handleDeclared` and call `handlers.handle` directly once the
// adopted Effect release contains Effect-TS/effect PR #8531 (merge 1f760401, fixes #8526: outer
// Effect requires HandlerServices) and PR #8530 (merge cf7cfd61, fixes #8527: Stream error adds
// AiError). Both merged after effect@4.0.0-rc.117. This only widens the declared channels to
// the merged signature; the runtime call is the unchanged native `handle`.
export const handleDeclared = <Tools extends Record<string, Tool.Any>, Name extends keyof Tools>(
  handlers: Toolkit.WithHandler<Tools>,
  name: Name,
  params: Tool.ParametersEncoded<Tools[Name]>,
  toolCallId: string,
): Effect.Effect<
  Stream.Stream<
    Tool.HandlerResult<Tools[Name]>,
    Tool.HandlerError<Tools[Name]> | AiError.AiError,
    Tool.HandlerServices<Tools[Name]>
  >,
  AiError.AiError,
  Tool.HandlerServices<Tools[Name]>
> => handlers.handle(name, params, toolCallId);
export const convertOuterDeclared = Effect.gen(function* () {
  const handlers = yield* kit;
  return yield* handleDeclared(handlers, "Convert", { n: "21" }, "outer");
});
export const renderReturnedStreamDeclared = Effect.gen(function* () {
  const handlers = yield* kit;
  return yield* handleDeclared(handlers, "RenderReturned", { n: 1 }, "stream");
});

const finish: Response.PartEncoded = {
  type: "finish",
  reason: "tool-calls",
  usage: { inputTokens: {}, outputTokens: {} },
};
// Fake Provider returning one encoded wire call for the transforming, serviceful input schema.
export const model = LanguageModel.make({
  generateText: () =>
    Effect.succeed([
      {
        type: "tool-call",
        id: "c1",
        name: "Convert",
        params: { n: "21" },
        providerExecuted: false,
      },
      finish,
    ]),
  streamText: () => Stream.empty,
});
// Caller-controlled resolution, the documented path for controlled dispatch.
export const generate = LanguageModel.generateText({
  prompt: "go",
  toolkit: kit,
  disableToolCallResolution: true,
});
// Controlled dispatch of the generated (encoded) call through native `handle`.
export const dispatch = Effect.gen(function* () {
  const response = yield* generate;
  const handlers = yield* kit;
  const results: Array<Tool.HandlerResult<typeof convert>> = [];
  for (const call of response.toolCalls) {
    if (call.name !== "Convert") continue;
    results.push(
      ...(yield* Stream.runCollect(yield* handlers.handle("Convert", call.params, call.id))),
    );
  }
  return { params: response.toolCalls.map((call) => call.params), results };
});
