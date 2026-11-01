// Compile-only fixture: the @ts-expect-error lines are the negative controls, so the language
// service's duplicate context/error diagnostics are skipped here.
// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file missingEffectError:skip-file */
import { Context, Effect, Layer, Predicate, type Scope, Schema, SchemaGetter } from "effect";
import { type AiError, LanguageModel, type Response, Tool, Toolkit } from "effect/ai";
import * as Core from "../../src/index.js";
import { isProvider } from "../../src/provider.js";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
const exact = <X, Y>(equal: Equal<X, Y>) => equal;

class Decoder extends Context.Service<Decoder, { readonly decode: (s: string) => number }>()(
  "fixture/Decoder",
) {}
class Db extends Context.Service<Db, { readonly write: (n: number) => Effect.Effect<void> }>()(
  "fixture/Db",
) {}
class Consent extends Context.Service<
  Consent,
  { readonly granted: (name: string) => Effect.Effect<boolean> }
>()("fixture/Consent") {}
class BuildInput extends Context.Service<BuildInput, { readonly ready: boolean }>()(
  "fixture/BuildInput",
) {}
class Undeclared extends Context.Service<Undeclared, { readonly n: number }>()(
  "fixture/Undeclared",
) {}
class Quota extends Schema.TaggedError<Quota>()("Quota", {}) {}
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
  if (!input.ready) return yield* new BuildError();
  return Kit.of({
    write: ({ n }) =>
      Effect.gen(function* () {
        const db = yield* Db;
        yield* db.write(n);
        if (n < 0) return yield* new Quota();
        return n;
      }),
    soft: ({ k }) => Effect.succeed(k),
  });
});

const registered = Core.localTools(Kit, builder);
exact<
  typeof registered,
  Effect.Effect<Core.LocalTools<Tools>, BuildError | Core.ToolRegistrationError, BuildInput>
>(true);

declare const tools: Core.LocalTools<Tools>;
declare const live: Core.NonDurableSession;

// Serviceful consent sees each call's own decoded parameters.
const consent = (call: Core.ToolCallRequest<Tools>) =>
  Effect.gen(function* () {
    const service = yield* Consent;
    if (call.name === "write") {
      exact<typeof call.params, { readonly n: number }>(true);
    }
    return yield* service.granted(call.name);
  });

type StepErrors =
  | AiError.AiError
  | Schema.SchemaError
  | Core.StepProtocolError
  | Core.ExecutionLimitError
  | Quota;
type Model = LanguageModel.LanguageModel | Core.ModelRequestAccounting;

const stepped = Core.step({ tools, policy: () => Effect.succeed("ask"), consent });
exact<
  typeof stepped,
  Effect.Effect<Core.StepResult<Tools>, StepErrors, Model | Core.Turn | Decoder | Db | Consent>
>(true);

const looped = Core.loop({ tools, consent });
exact<
  typeof looped,
  Effect.Effect<
    Core.CompleteStep<Tools>,
    StepErrors | Core.IncompleteStepError,
    Model | Core.Turn | Decoder | Db | Consent
  >
>(true);

// The Turn supplies itself; the Model, its accounting and Tool services stay required.
const inTurn = live.run(Core.step({ tools }));
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
  typeof Core.step,
  <T extends Record<string, Tool.Any> = {}, R = never>(
    options?: Core.StepOptions<T, R>,
  ) => Effect.Effect<
    Core.StepResult<T>,
    | AiError.AiError
    | Schema.SchemaError
    | Core.StepProtocolError
    | Core.ExecutionLimitError
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
const usesExtra = Effect.andThen(Extra, Core.step()).pipe(Effect.provide(declared));
exact<
  typeof usesExtra,
  Effect.Effect<
    Core.StepResult<{}>,
    | AiError.AiError
    | Schema.SchemaError
    | Core.StepProtocolError
    | Core.ExecutionLimitError
    | ProvisionError,
    Core.Turn | ProvisionInput
  >
>(true);

// Provisioning error and requirements are carried by the Provider and its Model binding.
const provider = Core.makeProvider("fixture", ["m"] as const, undefined, () => declared);
exact<typeof provider, Core.Provider<"fixture", readonly ["m"], ProvisionError, ProvisionInput>>(
  true,
);
const bound = Core.providerModel(provider, "m");
exact<
  typeof bound,
  Layer.Layer<
    LanguageModel.LanguageModel | Core.ModelRequestAccounting,
    ProvisionError | Core.StepProtocolError,
    ProvisionInput
  >
>(true);
const provided = Core.step().pipe(Effect.provide(bound));
exact<
  typeof provided,
  Effect.Effect<
    Core.StepResult<{}>,
    | AiError.AiError
    | Schema.SchemaError
    | Core.StepProtocolError
    | Core.ExecutionLimitError
    | ProvisionError,
    Core.Turn | ProvisionInput
  >
>(true);
// Declaration and catalog code holds open and closed Providers alike.
declare const closedLayer: Layer.Layer<LanguageModel.LanguageModel, "Failed">;
const closed = Core.makeProvider("closed", [] as const, undefined, () =>
  Core.withModelRequestAccounting("closed", closedLayer),
);
const anyClosed: Core.AnyProvider = closed;
const anyOpen: Core.AnyProvider = provider;
exact<Core.QualifiedModelId<typeof provider>, `fixture/${"m" | (string & {})}`>(true);
exact<ReturnType<typeof Core.credentialDescriptor>, Core.CredentialDescriptor | undefined>(true);
Core.credentialDescriptor(provider);
Core.credentialDescriptor(closed);
// A closed Provider's binding runs in a closed program.
const closedRun = Layer.build(Core.providerModel(closed, "m"));
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
const guardedRun = Layer.build(Core.providerModel(guarded, "m"));
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
declare const codedTools: Core.LocalTools<Toolkit.Tools<typeof CodedKit>>;
const coded = Core.step({ tools: codedTools });
exact<
  typeof coded,
  Effect.Effect<
    Core.StepResult<Toolkit.Tools<typeof CodedKit>>,
    | AiError.AiError
    | Schema.SchemaError
    | Core.StepProtocolError
    | Core.ExecutionLimitError
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
declare const encodedParamsTools: Core.LocalTools<Toolkit.Tools<typeof EncodedParamsKit>>;
const encodedParams = Core.step({ tools: encodedParamsTools });
exact<
  typeof encodedParams,
  Effect.Effect<
    Core.StepResult<Toolkit.Tools<typeof EncodedParamsKit>>,
    AiError.AiError | Schema.SchemaError | Core.StepProtocolError | Core.ExecutionLimitError,
    Model | Core.Turn | ParamsEncoder
  >
>(true);
const encodedParamsLoop = Core.loop({ tools: encodedParamsTools });
exact<
  typeof encodedParamsLoop,
  Effect.Effect<
    Core.CompleteStep<Toolkit.Tools<typeof EncodedParamsKit>>,
    | AiError.AiError
    | Schema.SchemaError
    | Core.StepProtocolError
    | Core.ExecutionLimitError
    | Core.IncompleteStepError,
    Model | Core.Turn | ParamsEncoder
  >
>(true);
// @ts-expect-error The parameter codec's encoding service is not erased from a Step.
const noParamsEncoder: Effect.Effect<
  Core.StepResult<Toolkit.Tools<typeof EncodedParamsKit>>,
  AiError.AiError | Schema.SchemaError | Core.StepProtocolError | Core.ExecutionLimitError,
  Model | Core.Turn
> = encodedParams;
// @ts-expect-error The parameter codec's encoding service is not erased from the default loop.
const noParamsEncoderLoop: Effect.Effect<
  Core.CompleteStep<Toolkit.Tools<typeof EncodedParamsKit>>,
  | AiError.AiError
  | Schema.SchemaError
  | Core.StepProtocolError
  | Core.ExecutionLimitError
  | Core.IncompleteStepError,
  Model | Core.Turn
> = encodedParamsLoop;

// A return-mode Tool's typed failure is returned as failure data, so upstream Effect 4.0.0 keeps it
// out of the handler error and the Step's error type.
class ReturnFailure extends Schema.TaggedError<ReturnFailure>()("ReturnFailure", {}) {}
const ReturnTool = Tool.make("returns", {
  parameters: Schema.Struct({ k: Schema.String }),
  success: Schema.String,
  failure: ReturnFailure,
  failureMode: "return",
});
const ReturnKit = Toolkit.make(ReturnTool);
declare const returnTools: Core.LocalTools<Toolkit.Tools<typeof ReturnKit>>;
const returning = Core.step({ tools: returnTools });
exact<Tool.HandlerError<typeof ReturnTool>, never>(true);
exact<
  typeof returning,
  Effect.Effect<
    Core.StepResult<Toolkit.Tools<typeof ReturnKit>>,
    AiError.AiError | Schema.SchemaError | Core.StepProtocolError | Core.ExecutionLimitError,
    Model | Core.Turn
  >
>(true);

// Recorded outcomes are typed by the registration that produced them.
const outcomes = Core.toolOutcomes(tools);
exact<
  typeof outcomes,
  Effect.Effect<
    ReadonlyArray<Response.ToolResultParts<Tools>>,
    Core.SessionReleasedError,
    Core.Turn
  >
>(true);
exact<typeof turnUsage, Effect.Effect<Core.ExecutionUsage, Core.SessionReleasedError>>(true);
declare const turnValue: Core.Turn["Service"];
const turnUsage = turnValue.usage;

// Complete results keep the original native response and separately resolved local results.
declare const complete: Core.CompleteStep<Tools>;
exact<typeof complete.response, LanguageModel.GenerateTextResponse<Tools, "encoded">>(true);
exact<(typeof complete.results)[number], Response.ToolResultParts<Tools>>(true);
declare const incomplete: Core.IncompleteStep<Tools>;
exact<typeof incomplete.reason, Response.FinishReason>(true);

// @ts-expect-error The Tool's declared handler dependency is not erased.
const noDb: Effect.Effect<
  Core.StepResult<Tools>,
  StepErrors,
  Model | Core.Turn | Decoder | Consent
> = stepped;
// @ts-expect-error The parameter codec's decoding service is not erased.
const noDecoder: Effect.Effect<
  Core.StepResult<Tools>,
  StepErrors,
  Model | Core.Turn | Db | Consent
> = stepped;
// @ts-expect-error Consent's service is not erased.
const noConsent: Effect.Effect<
  Core.StepResult<Tools>,
  StepErrors,
  Model | Core.Turn | Decoder | Db
> = stepped;
// @ts-expect-error Request accounting is a requirement, not optional.
const noAccounting: Effect.Effect<
  Core.StepResult<Tools>,
  StepErrors,
  LanguageModel.LanguageModel | Core.Turn | Decoder | Db | Consent
> = stepped;
// @ts-expect-error The Tool's typed failure is not erased.
const noQuota: Effect.Effect<
  Core.StepResult<Tools>,
  Exclude<StepErrors, Quota>,
  Model | Core.Turn | Decoder | Db | Consent
> = stepped;
// @ts-expect-error The default loop's incomplete failure is not erased.
const noIncomplete: Effect.Effect<
  Core.CompleteStep<Tools>,
  StepErrors,
  Model | Core.Turn | Decoder | Db | Consent
> = looped;
// @ts-expect-error The builder's service requirement is not erased.
const noBuildInput: Effect.Effect<
  Core.LocalTools<Tools>,
  BuildError | Core.ToolRegistrationError,
  never
> = registered;
// @ts-expect-error The builder's error is not erased.
const noBuildError: Effect.Effect<
  Core.LocalTools<Tools>,
  Core.ToolRegistrationError,
  BuildInput
> = registered;
// @ts-expect-error A handler map must cover every Tool.
const missing = Core.localTools(Kit, {
  soft: ({ k }: { readonly k: string }) => Effect.succeed(k),
});
const undeclared = Core.localTools(Kit, {
  // @ts-expect-error A handler may not need a service its Tool does not declare.
  write: () => Effect.map(Undeclared, ({ n }) => n),
  soft: ({ k }: { readonly k: string }) => Effect.succeed(k),
});
// @ts-expect-error A policy decision is allow, ask or deny.
const badDecision = Core.step({ tools, policy: () => Effect.succeed("maybe" as const) });
const badParams = Core.step({
  tools,
  // @ts-expect-error Consent receives the decoded parameters, which have no such field.
  consent: (call) => Effect.succeed(call.name === "write" && call.params.missing === 1),
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
> = Effect.andThen(Extra, Core.step()).pipe(
  Effect.provide(Core.withModelRequestAccounting("x", withoutExtra)),
);
// @ts-expect-error A guarded Provider is not a closed one.
const guardedClosed: Core.Provider<string, ReadonlyArray<string>, unknown, never> = guarded;
// @ts-expect-error Its binding cannot run in a program that supplies nothing.
const guardedAsClosed: Effect.Effect<unknown, unknown, Scope.Scope> = guardedRun;
// @ts-expect-error A serviceful Provider is not a closed one either.
const openClosed: Core.Provider<string, ReadonlyArray<string>, unknown, never> = provider;
// @ts-expect-error Outcomes cannot be read as another registration's Tools.
const wrongOutcomes: Effect.Effect<
  ReadonlyArray<Response.ToolResultParts<{ readonly soft: typeof Soft }>>,
  Core.SessionReleasedError,
  Core.Turn
> = outcomes;
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
const unaccounted: Effect.Effect<Core.StepResult<{}>, unknown, never> = Core.step().pipe(
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
  wrongOutcomes,
  badDecision,
  badParams,
  missing,
  noAccounting,
  noBuildError,
  noBuildInput,
  noConsent,
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
