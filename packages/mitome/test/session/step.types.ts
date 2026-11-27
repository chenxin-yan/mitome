// Compile-only fixture: the @ts-expect-error lines are the negative controls, so the language
// service's duplicate context/error diagnostics are skipped here.
// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file missingEffectError:skip-file */
import {
  Context,
  Effect,
  Layer,
  Predicate,
  type Scope,
  Schema,
  SchemaGetter,
  type Types,
} from "effect";
import { type AiError, LanguageModel, type Response, Tool, Toolkit } from "effect/ai";
import * as Core from "../../src/index.js";
import * as Kernel from "../../src/kernel.js";
import { isProvider } from "../../src/session/internal.js";

const exact = <X, Y>(equal: Types.Equals<X, Y>) => equal;

class Decoder extends Context.Service<Decoder, { readonly decode: (s: string) => number }>()(
  "fixture/Decoder",
) {}
class Db extends Context.Service<Db, { readonly write: (n: number) => Effect.Effect<void> }>()(
  "fixture/Db",
) {}
class Grants extends Context.Service<
  Grants,
  { readonly granted: (name: string) => Effect.Effect<boolean> }
>()("fixture/Grants") {}
class BuildInput extends Context.Service<BuildInput, { readonly ready: boolean }>()(
  "fixture/BuildInput",
) {}
class Undeclared extends Context.Service<Undeclared, { readonly n: number }>()(
  "fixture/Undeclared",
) {}
class Quota extends Schema.TaggedError<Quota, { readonly brand: unique symbol }>()("Quota", {}) {}
class BuildError extends Schema.TaggedError<BuildError>()("BuildError", {}) {}

// A serviceful parameter codec: decoding needs Decoder.
const Params = Schema.Struct({ n: Schema.String }).pipe(
  Schema.decodeTo(Schema.Struct({ n: Schema.Finite }), {
    decode: SchemaGetter.transformEffect(({ n }) =>
      Effect.map(Decoder, (decoder) => ({ n: decoder.decode(n) })),
    ),
    encode: SchemaGetter.transform(({ n }) => ({ n: String(n) })),
  }),
);
const Write = Tool.make("write", {
  parameters: Params,
  success: Schema.Finite,
  failure: Quota,
  dependencies: [Db],
});
const Soft = Tool.make("soft", {
  parameters: Schema.Struct({ k: Schema.String }),
  success: Schema.String,
  failureMode: "return",
});
const Kit = Toolkit.make(Write, Soft);
type Tools = Toolkit.Tools<typeof Kit>;

// A serviceful, fallible builder whose handlers need the Tool's declared dependency.
const builder = Effect.gen(function* () {
  const input = yield* BuildInput;
  if (!input.ready) {
    return yield* new BuildError();
  }
  return Kit.of({
    write: ({ n }) =>
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db.write(n);
        if (n < 0) {
          return yield* new Quota();
        }
        return n;
      }),
    soft: ({ k }) => Effect.succeed(k),
  });
});

const registered = Kernel.localTools(Kit, builder);
exact<
  typeof registered,
  Effect.Effect<Kernel.LocalTools<Tools>, BuildError | Core.ToolRegistrationError, BuildInput>
>(true);

declare const tools: Kernel.LocalTools<Tools>;
declare const live: Kernel.Session.Session;

// A serviceful restriction sees each call's own decoded parameters.
const restriction = (call: Core.ToolCallRequest<Tools>) =>
  Effect.gen(function* () {
    const service = yield* Grants;
    if (call.name === "write") {
      exact<typeof call.params, { readonly n: number }>(true);
    }
    return (yield* service.granted(call.name)) ? ("allow" as const) : ("deny" as const);
  });

type StepErrors =
  | AiError.AiError
  | Schema.SchemaError
  | Core.StepProtocolError
  | Core.ExecutionLimitError
  | Core.SessionSaveError
  | Core.SessionFencedError
  | Quota;
type Model = LanguageModel.LanguageModel | Core.ModelRequestAccounting;

const stepped = Kernel.step({
  tools,
  policy: () => Effect.succeed("ask"),
  restrictions: [restriction],
});
exact<
  typeof stepped,
  Effect.Effect<Core.StepResult<Tools>, StepErrors, Model | Core.Turn | Decoder | Db | Grants>
>(true);

const looped = Kernel.loop({ tools, restrictions: [restriction] });
exact<
  typeof looped,
  Effect.Effect<
    Core.CompleteStep<Tools>,
    StepErrors | Core.IncompleteStepError,
    Model | Core.Turn | Decoder | Db | Grants
  >
>(true);

// The Turn supplies itself; the Model, its accounting and Tool services stay required.
const inTurn = live.run(Kernel.step({ tools }));
exact<
  typeof inTurn,
  Effect.Effect<
    Core.StepResult<Tools>,
    StepErrors | Core.SessionBusyError | Core.SessionReleasedError,
    Model | Decoder | Db
  >
>(true);

// A step without Tools needs no Tool services and has no Tool errors.
exact<
  typeof Kernel.step,
  <T extends Record<string, Tool.Any> = {}, R = never>(
    options?: Kernel.StepOptions<T, R>,
  ) => Effect.Effect<
    Core.StepResult<T>,
    | AiError.AiError
    | Schema.SchemaError
    | Core.StepProtocolError
    | Core.ExecutionLimitError
    | Core.SessionSaveError
    | Core.SessionFencedError
    | Tool.HandlerError<T[keyof T]>,
    | Model
    | Core.Turn
    | Tool.HandlerServices<T[keyof T]>
    | Tool.ParametersEncodingServices<T[keyof T]>
    | R
  >
>(true);
exact<
  typeof Core.withModelRequestAccounting<"Out", "E", "R">,
  (
    binding: string,
    layer: Layer.Layer<"Out" | LanguageModel.LanguageModel, "E", "R">,
  ) => Layer.Layer<"Out" | Model, "E", "R">
>(true);

// A binding Layer's additional services, error and requirements survive the declaration.
class Extra extends Context.Service<Extra, { readonly n: number }>()("fixture/Extra") {}
class ProvisionInput extends Context.Service<ProvisionInput, { readonly key: string }>()(
  "fixture/ProvisionInput",
) {}
class ProvisionError extends Schema.TaggedError<ProvisionError>()("ProvisionError", {}) {}
declare const bindingLayer: Layer.Layer<
  LanguageModel.LanguageModel | Extra,
  ProvisionError,
  ProvisionInput
>;
const declared = Core.withModelRequestAccounting("fixture", bindingLayer);
exact<
  typeof declared,
  Layer.Layer<
    LanguageModel.LanguageModel | Extra | Core.ModelRequestAccounting,
    ProvisionError,
    ProvisionInput
  >
>(true);
const usesExtra = Effect.andThen(Extra, Kernel.step()).pipe(Effect.provide(declared));
exact<
  typeof usesExtra,
  Effect.Effect<
    Core.StepResult<{}>,
    | AiError.AiError
    | Schema.SchemaError
    | Core.StepProtocolError
    | Core.ExecutionLimitError
    | Core.SessionSaveError
    | Core.SessionFencedError
    | ProvisionError,
    Core.Turn | ProvisionInput
  >
>(true);

// Provisioning error and requirements are carried by the Provider and its Model binding.
const provider = Core.Provider.make("fixture", {
  modelIds: ["m"] as const,
  provision: () => declared,
});
exact<
  typeof provider,
  Core.Provider.Provider<"fixture", readonly ["m"], ProvisionError, ProvisionInput>
>(true);
const bound = Core.Provider.model(provider, "m");
exact<
  typeof bound,
  Layer.Layer<
    LanguageModel.LanguageModel | Core.ModelRequestAccounting,
    ProvisionError | Core.StepProtocolError,
    ProvisionInput
  >
>(true);
const provided = Kernel.step().pipe(Effect.provide(bound));
exact<
  typeof provided,
  Effect.Effect<
    Core.StepResult<{}>,
    | AiError.AiError
    | Schema.SchemaError
    | Core.StepProtocolError
    | Core.ExecutionLimitError
    | Core.SessionSaveError
    | Core.SessionFencedError
    | ProvisionError,
    Core.Turn | ProvisionInput
  >
>(true);
// Declaration and catalog code holds open and closed Providers alike.
declare const closedLayer: Layer.Layer<LanguageModel.LanguageModel, "Failed">;
const closed = Core.Provider.make("closed", {
  modelIds: [] as const,
  provision: () => Core.withModelRequestAccounting("closed", closedLayer),
});
const anyClosed: Core.Provider.AnyProvider = closed;
const anyOpen: Core.Provider.AnyProvider = provider;
exact<Core.Provider.QualifiedModelId<typeof provider>, `fixture/${"m" | (string & {})}`>(true);
exact<ReturnType<typeof Core.Provider.credentialDescriptor>, Core.CredentialDescriptor | undefined>(
  true,
);
Core.Provider.credentialDescriptor(provider);
Core.Provider.credentialDescriptor(closed);
// A closed Provider's binding runs in a closed program.
const closedRun = Layer.build(Core.Provider.model(closed, "m"));
exact<
  typeof closedRun,
  Effect.Effect<
    Context.Context<LanguageModel.LanguageModel | Core.ModelRequestAccounting>,
    "Failed" | Core.StepProtocolError,
    Scope.Scope
  >
>(true);
// A dynamically typed value guarded by the runtime brand is a Provider whose requirements are
// unknown: its binding still requires them, so it cannot run as if it needed nothing.
declare const loaded: unknown;
const guarded = Predicate.isObject(loaded) && isProvider(loaded) ? loaded : closed;
const guardedRun = Layer.build(Core.Provider.model(guarded, "m"));
exact<
  typeof guardedRun,
  Effect.Effect<
    Context.Context<LanguageModel.LanguageModel | Core.ModelRequestAccounting>,
    unknown,
    unknown
  >
>(true);

// Serviceful success and failure encodings are Step requirements; nothing erases them.
class SuccessEncoder extends Context.Service<SuccessEncoder, { readonly tag: string }>()(
  "fixture/SuccessEncoder",
) {}
class FailureEncoder extends Context.Service<FailureEncoder, { readonly tag: string }>()(
  "fixture/FailureEncoder",
) {}
const encodedWith = <S>(service: Context.Key<S, { readonly tag: string }>) =>
  Schema.String.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((value: string) => value),
      encode: SchemaGetter.transformEffect((value: string) =>
        Effect.map(service, (encoder) => `${encoder.tag}:${value}`),
      ),
    }),
  );
const CodedTool = Tool.make("coded", {
  parameters: Schema.Struct({ k: Schema.String }),
  success: encodedWith(SuccessEncoder),
  failure: encodedWith(FailureEncoder),
});
const CodedKit = Toolkit.make(CodedTool);
declare const codedTools: Kernel.LocalTools<Toolkit.Tools<typeof CodedKit>>;
const coded = Kernel.step({ tools: codedTools });
exact<
  typeof coded,
  Effect.Effect<
    Core.StepResult<Toolkit.Tools<typeof CodedKit>>,
    | AiError.AiError
    | Schema.SchemaError
    | Core.StepProtocolError
    | Core.ExecutionLimitError
    | Core.SessionSaveError
    | Core.SessionFencedError
    | string,
    Model | Core.Turn | SuccessEncoder | FailureEncoder
  >
>(true);

// A parameter codec whose decoding is pure but whose encoding needs a service: native generation
// with Tool resolution disabled may encode parameters, so the Step keeps that requirement.
class ParamsEncoder extends Context.Service<ParamsEncoder, { readonly tag: string }>()(
  "fixture/ParamsEncoder",
) {}
const EncodedParamsTool = Tool.make("encodedParams", {
  parameters: Schema.Struct({ k: encodedWith(ParamsEncoder) }),
  success: Schema.String,
});
const EncodedParamsKit = Toolkit.make(EncodedParamsTool);
declare const encodedParamsTools: Kernel.LocalTools<Toolkit.Tools<typeof EncodedParamsKit>>;
const encodedParams = Kernel.step({ tools: encodedParamsTools });
exact<
  typeof encodedParams,
  Effect.Effect<
    Core.StepResult<Toolkit.Tools<typeof EncodedParamsKit>>,
    | AiError.AiError
    | Schema.SchemaError
    | Core.StepProtocolError
    | Core.ExecutionLimitError
    | Core.SessionSaveError
    | Core.SessionFencedError,
    Model | Core.Turn | ParamsEncoder
  >
>(true);
const encodedParamsLoop = Kernel.loop({ tools: encodedParamsTools });
exact<
  typeof encodedParamsLoop,
  Effect.Effect<
    Core.CompleteStep<Toolkit.Tools<typeof EncodedParamsKit>>,
    | AiError.AiError
    | Schema.SchemaError
    | Core.StepProtocolError
    | Core.ExecutionLimitError
    | Core.SessionSaveError
    | Core.SessionFencedError
    | Core.IncompleteStepError,
    Model | Core.Turn | ParamsEncoder
  >
>(true);
// @ts-expect-error The parameter codec's encoding service is not erased from a Step.
const noParamsEncoder: Effect.Effect<
  Core.StepResult<Toolkit.Tools<typeof EncodedParamsKit>>,
  | AiError.AiError
  | Schema.SchemaError
  | Core.StepProtocolError
  | Core.ExecutionLimitError
  | Core.SessionSaveError
  | Core.SessionFencedError,
  Model | Core.Turn
> = encodedParams;
// @ts-expect-error The parameter codec's encoding service is not erased from the default loop.
const noParamsEncoderLoop: Effect.Effect<
  Core.CompleteStep<Toolkit.Tools<typeof EncodedParamsKit>>,
  | AiError.AiError
  | Schema.SchemaError
  | Core.StepProtocolError
  | Core.ExecutionLimitError
  | Core.SessionSaveError
  | Core.SessionFencedError
  | Core.IncompleteStepError,
  Model | Core.Turn
> = encodedParamsLoop;

// A return-mode Tool's typed failure is returned as failure data, so upstream Effect 4.1.6 keeps it
// out of the handler error and the Step's error type.
class ReturnFailure extends Schema.TaggedError<ReturnFailure>()("ReturnFailure", {}) {}
const ReturnTool = Tool.make("returns", {
  parameters: Schema.Struct({ k: Schema.String }),
  success: Schema.String,
  failure: ReturnFailure,
  failureMode: "return",
});
const ReturnKit = Toolkit.make(ReturnTool);
declare const returnTools: Kernel.LocalTools<Toolkit.Tools<typeof ReturnKit>>;
const returning = Kernel.step({ tools: returnTools });
exact<Tool.HandlerError<typeof ReturnTool>, never>(true);
exact<
  typeof returning,
  Effect.Effect<
    Core.StepResult<Toolkit.Tools<typeof ReturnKit>>,
    | AiError.AiError
    | Schema.SchemaError
    | Core.StepProtocolError
    | Core.ExecutionLimitError
    | Core.SessionSaveError
    | Core.SessionFencedError,
    Model | Core.Turn
  >
>(true);

exact<typeof turnUsage, Effect.Effect<Core.ExecutionUsage, Core.SessionReleasedError>>(true);
declare const turnValue: Core.Turn["Service"];
const turnUsage = turnValue.usage;

// Complete results keep the original native response and separately resolved local results.
declare const complete: Core.CompleteStep<Tools>;
exact<typeof complete.response, LanguageModel.GenerateTextResponse<Tools, "encoded">>(true);
exact<(typeof complete.results)[number], Core.StepToolResult<Tools>>(true);
// A gate denial is an AiError failure even for an error-mode Tool; name and success still narrow.
declare const result: Core.StepToolResult<Tools>;
if (result.name === "write") {
  if (result.isFailure) {
    exact<typeof result.result, Quota | typeof Tool.ExecutionFailure.Type | AiError.AiError>(true);
  } else {
    exact<typeof result.result, number>(true);
  }
}
exact<
  Extract<Core.StepResult<Tools>, { readonly _tag: "Incomplete" }>["reason"],
  Response.FinishReason
>(true);

// @ts-expect-error The Tool's declared handler dependency is not erased.
const noDb: Effect.Effect<
  Core.StepResult<Tools>,
  StepErrors,
  Model | Core.Turn | Decoder | Grants
> = stepped;
// @ts-expect-error The parameter codec's decoding service is not erased.
const noDecoder: Effect.Effect<
  Core.StepResult<Tools>,
  StepErrors,
  Model | Core.Turn | Db | Grants
> = stepped;
// @ts-expect-error A restriction's service is not erased.
const noGrants: Effect.Effect<
  Core.StepResult<Tools>,
  StepErrors,
  Model | Core.Turn | Decoder | Db
> = stepped;
// @ts-expect-error Request accounting is a requirement, not optional.
const noAccounting: Effect.Effect<
  Core.StepResult<Tools>,
  StepErrors,
  LanguageModel.LanguageModel | Core.Turn | Decoder | Db | Grants
> = stepped;
// @ts-expect-error The Tool's typed failure is not erased.
const noQuota: Effect.Effect<
  Core.StepResult<Tools>,
  Exclude<StepErrors, Quota>,
  Model | Core.Turn | Decoder | Db | Grants
> = stepped;
// @ts-expect-error The default loop's incomplete failure is not erased.
const noIncomplete: Effect.Effect<
  Core.CompleteStep<Tools>,
  StepErrors,
  Model | Core.Turn | Decoder | Db | Grants
> = looped;
// @ts-expect-error The builder's service requirement is not erased.
const noBuildInput: Effect.Effect<
  Kernel.LocalTools<Tools>,
  BuildError | Core.ToolRegistrationError,
  never
> = registered;
// @ts-expect-error The builder's error is not erased.
const noBuildError: Effect.Effect<
  Kernel.LocalTools<Tools>,
  Core.ToolRegistrationError,
  BuildInput
> = registered;
// @ts-expect-error A handler map must cover every Tool.
const missing = Kernel.localTools(Kit, {
  soft: ({ k }: { readonly k: string }) => Effect.succeed(k),
});
const undeclared = Kernel.localTools(Kit, {
  // @ts-expect-error A handler may not need a service its Tool does not declare.
  write: () => Effect.map(Undeclared, ({ n }) => n),
  soft: ({ k }: { readonly k: string }) => Effect.succeed(k),
});
// @ts-expect-error A policy decision is allow, ask or deny.
const badDecision = Kernel.step({ tools, policy: () => Effect.succeed("maybe" as const) });
const badParams = Kernel.step({
  tools,
  restrictions: [
    (call) =>
      // @ts-expect-error A restriction receives the decoded parameters, which have no such field.
      Effect.succeed(call.name === "write" && call.params.missing === 1 ? "deny" : "allow"),
  ],
});
// @ts-expect-error An incomplete Step carries no local results.
const noResults = incomplete.results;
// @ts-expect-error The provisioning error is not erased when the binding is provided.
const noProvisionError: Effect.Effect<
  Core.StepResult<{}>,
  Exclude<StepErrors, Quota>,
  Core.Turn | ProvisionInput
> = provided;
// @ts-expect-error The provisioning requirement is not erased when the binding is provided.
const noProvisionInput: Effect.Effect<
  Core.StepResult<{}>,
  StepErrors | ProvisionError,
  Core.Turn
> = provided;
// A binding without the extra service leaves it required: the positive check above is not vacuous.
declare const withoutExtra: Layer.Layer<
  LanguageModel.LanguageModel,
  ProvisionError,
  ProvisionInput
>;
// @ts-expect-error Extra is still required when the binding does not provide it.
const extraLost: Effect.Effect<
  Core.StepResult<{}>,
  StepErrors | ProvisionError,
  Core.Turn | ProvisionInput
> = Effect.andThen(Extra, Kernel.step()).pipe(
  Effect.provide(Core.withModelRequestAccounting("x", withoutExtra)),
);
// @ts-expect-error A guarded Provider is not a closed one.
const guardedClosed: Core.Provider.Provider<
  string,
  ReadonlyArray<string>,
  unknown,
  never
> = guarded;
// @ts-expect-error Its binding cannot run in a program that supplies nothing.
const guardedAsClosed: Effect.Effect<unknown, unknown, Scope.Scope> = guardedRun;
// @ts-expect-error A serviceful Provider is not a closed one either.
const openClosed: Core.Provider.Provider<string, ReadonlyArray<string>, unknown, never> = provider;
// @ts-expect-error The success encoding service is not erased.
const noSuccessEncoder: Effect.Effect<
  Core.StepResult<Toolkit.Tools<typeof CodedKit>>,
  unknown,
  Model | Core.Turn | FailureEncoder
> = coded;
// @ts-expect-error The failure encoding service is not erased.
const noFailureEncoder: Effect.Effect<
  Core.StepResult<Toolkit.Tools<typeof CodedKit>>,
  unknown,
  Model | Core.Turn | SuccessEncoder
> = coded;
// @ts-expect-error Usage reads fail after release; the error is not erased.
const usageNever: Effect.Effect<Core.ExecutionUsage> = turnUsage;
// A plain Model binding without accounting cannot satisfy a Step.
declare const plainModel: Layer.Layer<LanguageModel.LanguageModel>;
declare const turn: Core.Turn["Service"];
// @ts-expect-error ModelRequestAccounting is still missing.
const unaccounted: Effect.Effect<Core.StepResult<{}>, unknown, never> = Kernel.step().pipe(
  Effect.provide(plainModel),
  Effect.provideService(Core.Turn, turn),
);

export {
  noFailureEncoder,
  noSuccessEncoder,
  anyClosed,
  anyOpen,
  guardedAsClosed,
  guardedClosed,
  openClosed,
  extraLost,
  noProvisionError,
  noProvisionInput,
  usageNever,
  badDecision,
  badParams,
  missing,
  noAccounting,
  noBuildError,
  noBuildInput,
  noGrants,
  noDb,
  noDecoder,
  noIncomplete,
  noParamsEncoder,
  noParamsEncoderLoop,
  noQuota,
  noResults,
  unaccounted,
  undeclared,
};
