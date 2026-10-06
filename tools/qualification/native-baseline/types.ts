// Compile-only exact A/E/R evidence for fixture.ts on the installed, unpatched Effect 4.0.0.
// Not a runtime test.
// Each `@ts-expect-error` is an intended rejection; the evidence runner also compiles an
// unsuppressed copy and requires exactly those diagnostics.
import { Effect } from "effect";
import type { Layer, Scope, Stream } from "effect";
import type { AiError, LanguageModel, Tool, Toolkit } from "effect/ai";
import * as F from "./fixture.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type Handlers = Tool.HandlersFor<Toolkit.Tools<typeof F.kit>>;
type Converted = Array<Tool.HandlerResult<typeof F.convert>>;
type Rendered = Array<Tool.HandlerResult<typeof F.render>>;
type RenderE = "user-failed" | AiError.AiError;
type RenderR = Handlers | F.Encoder | F.Invocation;
type ConvertR = RenderR | F.Decoder;
type Generated = Effect.Success<typeof F.generate>;

export type Checks = [
  // Serviceful input and output schemas plus declared handler dependencies.
  Assert<Equal<Tool.HandlerServices<typeof F.convert>, F.Decoder | F.Encoder | F.Invocation>>,
  Assert<Equal<Tool.HandlerServices<typeof F.render>, F.Encoder | F.Invocation>>,
  Assert<Equal<Tool.ResultEncodingServices<typeof F.render>, F.Encoder>>,
  Assert<Equal<Tool.ParametersEncoded<typeof F.convert>, { readonly n: string }>>,
  // Error mode declares typed failures.
  Assert<Equal<Tool.HandlerError<typeof F.render>, RenderE>>,
  // Return mode returns the typed failure as data, so HandlerError declares none.
  Assert<Equal<Tool.HandlerError<typeof F.renderReturned>, never>>,
  // Fallible scoped acquisition; Layer manages the Scope.
  Assert<Equal<Effect.Error<typeof F.builder>, F.BuildFailed>>,
  Assert<Equal<Effect.Services<typeof F.builder>, F.Infrastructure | Scope.Scope>>,
  Assert<Equal<Layer.Success<typeof F.handlersLayer>, Handlers>>,
  Assert<Equal<Layer.Error<typeof F.handlersLayer>, F.BuildFailed>>,
  Assert<Equal<Layer.Services<typeof F.handlersLayer>, F.Infrastructure>>,
  // Native whole operation keeps exact result, error and services (Decoder included).
  Assert<Equal<Effect.Success<ReturnType<typeof F.convertAll>>, Converted>>,
  Assert<Equal<Effect.Error<ReturnType<typeof F.convertAll>>, RenderE>>,
  Assert<Equal<Effect.Services<ReturnType<typeof F.convertAll>>, ConvertR>>,
  Assert<Equal<Effect.Success<ReturnType<typeof F.renderAll>>, Rendered>>,
  Assert<Equal<Effect.Error<ReturnType<typeof F.renderAll>>, RenderE>>,
  Assert<Equal<Effect.Services<ReturnType<typeof F.renderAll>>, RenderR>>,
  Assert<Equal<Effect.Error<ReturnType<typeof F.renderReturnedAll>>, AiError.AiError>>,
  // Disabled resolution returns encoded params and declares no Decoder, truthfully.
  Assert<
    Equal<
      Extract<Generated["toolCalls"][number], { name: "Convert" }>["params"],
      { readonly n: string }
    >
  >,
  Assert<Equal<Effect.Services<typeof F.generate>, LanguageModel.LanguageModel>>,
  Assert<Equal<Effect.Services<typeof F.dispatch>, LanguageModel.LanguageModel | ConvertR>>,
  Assert<Equal<Effect.Error<typeof F.dispatch>, RenderE>>,
  // Direct native `handle`: the outer Effect requires the Decoder that decodes parameters (#8526).
  Assert<Equal<Effect.Services<typeof F.convertOuterNative>, ConvertR>>,
  // The return-mode Stream error is HandlerError (`never`) plus AiError (#8527): AiError alone.
  Assert<Equal<Stream.Error<Effect.Success<typeof F.renderReturnedStreamNative>>, AiError.AiError>>,
];

// Equal itself distinguishes supersets and subsets.
// @ts-expect-error superset is not equal
export type EqualRejectsSuperset = Assert<Equal<F.Encoder | F.Invocation, F.Encoder>>;
// @ts-expect-error subset is not equal
export type EqualRejectsSubset = Assert<Equal<F.Encoder, F.Encoder | F.Invocation>>;

declare const renderOp: ReturnType<typeof F.renderAll>;
declare const convertOp: ReturnType<typeof F.convertAll>;
declare const handlers: Toolkit.WithHandler<Toolkit.Tools<typeof F.kit>>;
declare const returnedStream: Effect.Success<typeof F.renderReturnedStreamNative>;
export const rejected = [
  // @ts-expect-error input-decoding service cannot disappear from the whole operation
  convertOp satisfies Effect.Effect<Converted, RenderE, Exclude<ConvertR, F.Decoder>>,
  // @ts-expect-error output-encoding service cannot disappear
  renderOp satisfies Effect.Effect<Rendered, RenderE, Exclude<RenderR, F.Encoder>>,
  // @ts-expect-error declared handler dependency cannot disappear
  renderOp satisfies Effect.Effect<Rendered, RenderE, Exclude<RenderR, F.Invocation>>,
  // @ts-expect-error typed handler failure cannot disappear
  renderOp satisfies Effect.Effect<Rendered, AiError.AiError, RenderR>,
  // @ts-expect-error acquisition failure cannot disappear
  F.handlersLayer satisfies Layer.Layer<Handlers, never, F.Infrastructure>,
  // @ts-expect-error acquisition requirement cannot disappear
  F.handlersLayer satisfies Layer.Layer<Handlers, F.BuildFailed>,
  F.kit.of({
    Convert: ({ n }) => Effect.succeed(n),
    // @ts-expect-error registration cannot use an undeclared service (Infrastructure)
    Render: () => F.Infrastructure.useSync(() => 1),
    RenderReturned: ({ n }) => Effect.succeed(n),
  }),
  // @ts-expect-error 4.0.0 `handle` takes encoded params, so a decoded value is rejected
  handlers.handle("Convert", { n: 21 }),
  // @ts-expect-error the outer Effect cannot drop the parameter Decoder
  F.convertOuterNative satisfies Effect.Effect<
    Effect.Success<typeof F.convertOuterNative>,
    AiError.AiError,
    Exclude<ConvertR, F.Decoder>
  >,
  // @ts-expect-error the return-mode Stream cannot drop AiError (result encoding)
  returnedStream satisfies Stream.Stream<
    Stream.Success<typeof returnedStream>,
    "user-failed",
    Stream.Services<typeof returnedStream>
  >,
];
