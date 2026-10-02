// Compile-only fixture: the @ts-expect-error lines are the negative controls, so the language
// service's duplicate context/error diagnostics are skipped here.
// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file missingEffectError:skip-file missingLayerContext:skip-file */
import { Context, Effect, Layer, type Scope, Schema } from "effect";
import { LanguageModel } from "effect/ai";
import * as Core from "../src/index.js";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
const exact = <X, Y>(equal: Equal<X, Y>) => equal;

class Db extends Context.Service<Db, { readonly label: string }>()("fixture/Db") {}
class Clock extends Context.Service<Clock, { readonly now: number }>()("fixture/Clock") {}
class Undeclared extends Context.Service<Undeclared, { readonly n: number }>()(
  "fixture/Undeclared",
) {}
class DbError extends Schema.TaggedError<DbError>()("DbError", {}) {}
class AppError extends Schema.TaggedError<AppError>()("AppError", {}) {}
class ParseError extends Schema.TaggedError<ParseError>()("ParseError", {}) {}
class RenderError extends Schema.TaggedError<RenderError>()("RenderError", {}) {}
class HostError extends Schema.TaggedError<HostError>()("HostError", {}) {}

// SAFETY: this compile-only fixture never executes the LanguageModel service.
const model = Layer.succeed(LanguageModel.LanguageModel, {} as LanguageModel.LanguageModel);
const alpha = Core.makeProvider("alpha", ["known"] as const, undefined, () =>
  Layer.mergeAll(model, Layer.effectDiscard(Effect.fail("alpha-unavailable" as const))),
);
// A Provider whose provisioning needs a service only the infrastructure supplies.
const beta = Core.makeProvider("beta", [], undefined, () =>
  Layer.effect(
    LanguageModel.LanguageModel,
    // SAFETY: this compile-only fixture never executes the LanguageModel service.
    Effect.map(Clock, () => ({}) as LanguageModel.LanguageModel),
  ),
);

const infrastructure: Layer.Layer<Db | Clock, DbError> = Layer.mergeAll(
  Layer.succeed(Db, { label: "db" }),
  Layer.succeed(Clock, { now: 0 }),
  Layer.effectDiscard(Effect.fail(new DbError())),
);

// The original ordinary program: its own input, result, error and requirements.
const program = (input: { readonly topic: string }) =>
  Effect.gen(function* () {
    const turn = yield* Core.Turn;
    const db = yield* Db;
    yield* LanguageModel.LanguageModel;
    yield* Effect.addFinalizer(() => Effect.void);
    if (input.topic === "") return yield* new AppError();
    return { id: turn.id, label: db.label, length: input.topic.length };
  });
type Program = typeof program;

const app = Core.defineMitome({
  program,
  limits: Core.firstPartyExecutionLimits,
  infrastructure,
  providers: [alpha, beta],
  defaultModel: "alpha/known",
  fallbackModels: ["beta/any-native-id"],
  cli: {
    parseInput: (text: string) =>
      text === "" ? Effect.fail(new ParseError()) : Effect.succeed({ topic: text }),
    renderResult: (result) =>
      Effect.map(Db, (db) => (result.label === db.label ? `${result.length}` : "?")).pipe(
        Effect.andThen((text) =>
          text === "?" ? Effect.fail(new RenderError()) : Effect.succeed(text),
        ),
      ),
  },
  hosts: [
    {
      name: "fixture",
      start: (application) =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.void);
          const { now } = yield* Clock;
          if (now < 0) return yield* new HostError();
          const session = yield* application.session;
          return Effect.andThen(Db, session.run({ topic: "served" }));
        }),
    },
  ],
});

type Acquired = Effect.Success<ReturnType<typeof app.acquire>>;
type Session = Effect.Success<Acquired["session"]>;
declare const acquired: Acquired;
declare const result: Effect.Success<ReturnType<Program>>;
const rendered = acquired.provide(app.cli!.renderResult(result));

export const contracts = [
  // The original function, native Layer and Provider tuple are kept as the author wrote them.
  exact<typeof app.program, Program>(true),
  exact<NonNullable<typeof app.infrastructure>, Layer.Layer<Db | Clock, DbError>>(true),
  exact<NonNullable<typeof app.providers>, readonly [typeof alpha, typeof beta]>(true),
  exact<
    Effect.Services<ReturnType<Program>>,
    Core.Turn | Db | LanguageModel.LanguageModel | Scope.Scope
  >(true),
  // Acquisition keeps infrastructure, provisioning and Host startup failures (here the Host's own
  // HostError and its Session allocation), and needs only the Scope that owns the application.
  exact<
    Effect.Error<ReturnType<typeof app.acquire>>,
    | DbError
    | "alpha-unavailable"
    | Core.StepProtocolError
    | Core.ModelSelectionError
    | HostError
    | Core.ApplicationClosedError
  >(true),
  exact<Effect.Services<ReturnType<typeof app.acquire>>, Scope.Scope>(true),
  // A Session run supplies Turn, Scope and the bound services; only Session errors are added.
  exact<Parameters<Session["run"]>[0], { readonly topic: string }>(true),
  exact<Effect.Success<ReturnType<Session["run"]>>, Effect.Success<ReturnType<Program>>>(true),
  exact<
    Effect.Error<ReturnType<Session["run"]>>,
    AppError | Core.SessionBusyError | Core.SessionReleasedError | Core.ApplicationClosedError
  >(true),
  exact<Effect.Services<ReturnType<Session["run"]>>, never>(true),
  // CLI mappings keep their own failures; binding them supplies their infrastructure services.
  exact<Effect.Error<ReturnType<NonNullable<typeof app.cli>["parseInput"]>>, ParseError>(true),
  exact<Effect.Error<typeof rendered>, RenderError | Core.ApplicationClosedError>(true),
  exact<Effect.Services<typeof rendered>, never>(true),
];

// Acquiring a callback under provision does not bind the callback: its later Effect still needs Db.
const merelyAcquired = Effect.succeed(() => Effect.map(Db, (db) => db.label)).pipe(
  Effect.provide(Layer.succeed(Db, { label: "db" })),
);
type Callback = Effect.Success<typeof merelyAcquired>;
export const counterexample = [
  exact<Effect.Services<typeof merelyAcquired>, never>(true),
  exact<Effect.Services<ReturnType<Callback>>, Db>(true),
];

// An application that needs no Model may omit Providers and selection entirely.
const noModel = Core.defineMitome({
  program: (input: string) => Effect.succeed(input.length),
  limits: Core.firstPartyExecutionLimits,
});
export const noModelContracts = [
  exact<Effect.Services<ReturnType<typeof noModel.acquire>>, Scope.Scope>(true),
  exact<
    Effect.Error<ReturnType<typeof noModel.acquire>>,
    Core.StepProtocolError | Core.ModelSelectionError
  >(true),
];

Core.defineMitome({
  // @ts-expect-error The program's unsupplied service is not closed by anything.
  program: () => Undeclared,
  limits: Core.firstPartyExecutionLimits,
  infrastructure,
});

Core.defineMitome({
  // @ts-expect-error A merely acquired callback still needs Db when invoked without infrastructure.
  program: Effect.runSync(merelyAcquired),
  limits: Core.firstPartyExecutionLimits,
});

Core.defineMitome({
  // @ts-expect-error Without Providers nothing supplies a Model.
  program: () => LanguageModel.LanguageModel,
  limits: Core.firstPartyExecutionLimits,
});

Core.defineMitome({
  program: () => Effect.void,
  limits: Core.firstPartyExecutionLimits,
  // @ts-expect-error The infrastructure itself may require nothing.
  infrastructure: Layer.effect(Db, Effect.as(Undeclared, { label: "db" })),
});

Core.defineMitome({
  program: () => Effect.void,
  limits: Core.firstPartyExecutionLimits,
  // @ts-expect-error Beta's provisioning needs Clock, which no infrastructure supplies.
  providers: [beta],
  defaultModel: "beta/any",
});

Core.defineMitome({
  program: () => Effect.void,
  limits: Core.firstPartyExecutionLimits,
  providers: [alpha],
  // @ts-expect-error A configured Model must name a declared Provider.
  defaultModel: "gamma/known",
});

Core.defineMitome({
  program: (input: string) => Effect.succeed(input),
  limits: Core.firstPartyExecutionLimits,
  infrastructure,
  cli: {
    // @ts-expect-error The parser's unsupplied service is not closed by anything.
    parseInput: (text: string) => Effect.as(Undeclared, text),
    renderResult: Effect.succeed,
  },
});

Core.defineMitome({
  program: (input: string) => Effect.succeed(input),
  limits: Core.firstPartyExecutionLimits,
  cli: {
    parseInput: Effect.succeed,
    // @ts-expect-error The renderer's Db is supplied only by infrastructure this app lacks.
    renderResult: (result: string) => Effect.as(Db, result),
  },
});

Core.defineMitome({
  program: (input: string) => Effect.succeed(input),
  limits: Core.firstPartyExecutionLimits,
  hosts: [
    {
      name: "unclosed",
      // @ts-expect-error The Host's serving Effect needs a service nothing supplies.
      start: () => Effect.succeed(Undeclared),
    },
  ],
});
