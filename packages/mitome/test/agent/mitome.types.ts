// Compile-only fixture: the @ts-expect-error lines are the negative controls, so the language
// service's duplicate context/error diagnostics are skipped here.
// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file missingEffectError:skip-file missingLayerContext:skip-file */
import { Context, Effect, Layer, type Scope, Schema, type Types } from "effect";
import { LanguageModel } from "effect/ai";
import * as Core from "../../src/index.js";

const exact = <X, Y>(equal: Types.Equals<X, Y>) => equal;

class Db extends Context.Service<Db, { readonly label: string }>()("fixture/Db") {}
class Clock extends Context.Service<Clock, { readonly now: number }>()("fixture/Clock") {}
class Undeclared extends Context.Service<Undeclared, { readonly n: number }>()(
  "fixture/Undeclared",
) {}
class DbError extends Schema.TaggedError<DbError>()("DbError", {}) {}
class AppError extends Schema.TaggedError<AppError>()("AppError", {}) {}
class ParseError extends Schema.TaggedError<ParseError>()("ParseError", {}) {}
class RenderError extends Schema.TaggedError<RenderError>()("RenderError", {}) {}
class NotesError extends Schema.TaggedError<NotesError>()("NotesError", {}) {}

// SAFETY: this compile-only fixture never executes the LanguageModel service.
const model = Layer.succeed(LanguageModel.LanguageModel, {} as LanguageModel.LanguageModel);
const alpha = Core.Provider.make("alpha", {
  modelIds: ["known"] as const,
  provision: () =>
    Layer.mergeAll(model, Layer.effectDiscard(Effect.fail("alpha-unavailable" as const))),
});
// A Provider whose provisioning needs a service only the Configuration provides.
const beta = Core.Provider.make("beta", {
  modelIds: [],
  provision: () =>
    Layer.effect(
      LanguageModel.LanguageModel,
      // SAFETY: this compile-only fixture never executes the LanguageModel service.
      Effect.map(Clock, () => ({}) as LanguageModel.LanguageModel),
    ),
});

const layer: Layer.Layer<Db | Clock, DbError> = Layer.mergeAll(
  Layer.succeed(Db, { label: "db" }),
  Layer.succeed(Clock, { now: 0 }),
  Layer.effectDiscard(Effect.fail(new DbError())),
);

// An Extension whose setup needs Clock from the Configuration's services.
const notes = Core.Extension.make(
  "notes",
  Effect.gen(function* () {
    const { now } = yield* Clock;
    if (now < 0) {
      return yield* new NotesError();
    }
    return { instructions: `Notes from ${now}.` };
  }),
);

// The original ordinary program: its own input, result, error and requirements.
const program = (input: { readonly topic: string }) =>
  Effect.gen(function* () {
    const turn = yield* Core.Turn;
    const db = yield* Db;
    yield* LanguageModel.LanguageModel;
    yield* Effect.addFinalizer(() => Effect.void);
    if (input.topic === "") {
      return yield* new AppError();
    }
    return { id: turn.id, label: db.label, length: input.topic.length };
  });
type Program = typeof program;

const agent = Core.Agent.make({
  use: [notes],
  program,
  text: {
    parse: (text: string) =>
      text === "" ? Effect.fail(new ParseError()) : Effect.succeed({ topic: text }),
    render: (result) =>
      Effect.map(Db, (db) => (result.label === db.label ? `${result.length}` : "?")).pipe(
        Effect.andThen((text) =>
          text === "?" ? Effect.fail(new RenderError()) : Effect.succeed(text),
        ),
      ),
  },
});

const app = Core.Mitome.make({
  agent,
  provide: layer,
  providers: [alpha, beta],
  model: "alpha/known",
});

type Acquired = Effect.Success<ReturnType<typeof app.acquire>>;
type Session = Effect.Success<ReturnType<Acquired["session"]>>;
declare const acquired: Acquired;
declare const result: Effect.Success<ReturnType<Program>>;
const rendered = acquired.provide(app.text.render(result));

export const contracts = [
  // The Agent's program, provided Layer and Provider tuple are kept as the author wrote them; the
  // program only gains the `steps` argument it ignores.
  exact<
    typeof app.agent.program,
    (
      input: Parameters<Program>[0],
      steps: Core.Agent.AgentSteps<readonly [typeof notes], never>,
    ) => ReturnType<Program>
  >(true),
  exact<NonNullable<typeof app.provide>, Layer.Layer<Db | Clock, DbError>>(true),
  exact<NonNullable<typeof app.providers>, readonly [typeof alpha, typeof beta]>(true),
  exact<
    Effect.Services<ReturnType<Program>>,
    Core.Turn | Db | LanguageModel.LanguageModel | Scope.Scope
  >(true),
  // Acquisition keeps the provided Layer's and provisioning failures, and needs only the Scope
  // that owns the instance.
  exact<
    Effect.Error<ReturnType<typeof app.acquire>>,
    DbError | "alpha-unavailable" | Core.StepProtocolError | Core.ModelSelectionError
  >(true),
  exact<Effect.Services<ReturnType<typeof app.acquire>>, Scope.Scope>(true),
  // Allocating a Session runs its Agent's setups and opens the conversation it selects.
  exact<Parameters<Acquired["session"]>, [options?: Core.Session.SessionOptions | undefined]>(true),
  exact<
    Effect.Error<ReturnType<Acquired["session"]>>,
    | Core.MitomeClosedError
    | NotesError
    | Core.ToolRegistrationError
    | Core.TranscriptError
    | Core.TranscriptSelectionError
  >(true),
  // A Session run supplies Turn, Scope and the bound services; only Session errors are added.
  exact<Parameters<Session["run"]>[0], { readonly topic: string }>(true),
  exact<Effect.Success<ReturnType<Session["run"]>>, Effect.Success<ReturnType<Program>>>(true),
  exact<
    Effect.Error<ReturnType<Session["run"]>>,
    | AppError
    | Core.SessionBusyError
    | Core.SessionReleasedError
    | Core.SessionSaveError
    | Core.SessionFencedError
    | Core.MitomeClosedError
  >(true),
  exact<
    Effect.Error<ReturnType<Session["moveTo"]>>,
    | Core.SessionBusyError
    | Core.SessionReleasedError
    | Core.TranscriptError
    | Core.SessionSaveError
    | Core.SessionFencedError
    | Core.MitomeClosedError
  >(true),
  exact<Effect.Services<ReturnType<Session["run"]>>, never>(true),
  // The parser and renderer keep their own failures; binding them supplies the provided services.
  exact<Effect.Error<ReturnType<typeof app.text.parse>>, ParseError>(true),
  exact<Effect.Error<typeof rendered>, RenderError | Core.MitomeClosedError>(true),
  exact<Effect.Services<typeof rendered>, never>(true),
];

// An Agent whose input and result are text gets the identity mapping.
const echo = Core.Mitome.make({
  agent: Core.Agent.make({ program: (input: string) => Effect.succeed(input) }),
});
export const echoContracts = [
  exact<Parameters<typeof echo.text.parse>[0], string>(true),
  exact<Effect.Success<ReturnType<typeof echo.text.parse>>, string>(true),
  exact<Effect.Error<ReturnType<typeof echo.text.render>>, Core.TextMappingError>(true),
];

// A Configuration whose Agent needs no Model may omit Providers and selection entirely.
const noModel = Core.Mitome.make({
  agent: Core.Agent.make({
    program: (input: string) => Effect.succeed(input.length),
    text: { parse: Effect.succeed, render: (n) => Effect.succeed(`${n}`) },
  }),
});
export const noModelContracts = [
  exact<Effect.Services<ReturnType<typeof noModel.acquire>>, Scope.Scope>(true),
  exact<
    Effect.Error<ReturnType<typeof noModel.acquire>>,
    Core.StepProtocolError | Core.ModelSelectionError
  >(true),
];

// Acquiring a callback under provision does not bind the callback: its later Effect still needs Db.
const merelyAcquired = Effect.succeed(() => Effect.map(Db, (db) => db.label)).pipe(
  Effect.provideService(Db, { label: "db" }),
);
type Callback = Effect.Success<typeof merelyAcquired>;
export const counterexample = [
  exact<Effect.Services<typeof merelyAcquired>, never>(true),
  exact<Effect.Services<ReturnType<Callback>>, Db>(true),
];

Core.Mitome.make({
  // @ts-expect-error The program's unsupplied service is not closed by anything.
  agent: Core.Agent.make({ program: () => Effect.as(Undeclared, "") }),
  provide: layer,
});

Core.Mitome.make({
  // @ts-expect-error A merely acquired callback still needs Db when nothing provides it.
  agent: Core.Agent.make({ program: Effect.runSync(merelyAcquired) }),
});

Core.Mitome.make({
  // @ts-expect-error Without Providers nothing supplies a Model to the default program.
  agent: Core.Agent.make({}),
});

// A Provider tuple supplies the default program's Model; a widened array may be empty, so it does not.
Core.Mitome.make({ agent: Core.Agent.make({}), providers: [alpha], model: "alpha/known" });
declare const widened: Array<typeof alpha>;
Core.Mitome.make({
  // @ts-expect-error A widened Provider array does not promise a Model.
  agent: Core.Agent.make({}),
  providers: widened,
});

declare const maybeNone: readonly [] | readonly [typeof alpha];
Core.Mitome.make({
  // @ts-expect-error A Provider list that may be the empty tuple does not promise a Model.
  agent: Core.Agent.make({}),
  providers: maybeNone,
});

Core.Mitome.make({
  // @ts-expect-error Without Providers nothing supplies a Model to a custom program either.
  agent: Core.Agent.make({ program: () => Effect.as(LanguageModel.LanguageModel, "") }),
});

// A setup's Clock and Undeclared, and a Command's, are needed from the Configuration.
Core.Mitome.make({
  agent: Core.Agent.make({ use: [notes], program: (input: string) => Effect.succeed(input) }),
  provide: layer,
});
const undeclared = Core.Extension.make("undeclared", Effect.as(Undeclared, {}));
Core.Mitome.make({
  // @ts-expect-error A setup needs Undeclared, which nothing provides.
  agent: Core.Agent.make({ use: [undeclared], program: (input: string) => Effect.succeed(input) }),
  provide: layer,
});
const asking = Core.Extension.make("asking", {
  commands: [
    Core.Command.make("ask", {
      description: "Ask",
      run: () => Effect.as(Undeclared, Core.Command.reply("")),
    }),
  ],
});
Core.Mitome.make({
  // @ts-expect-error A Command needs Undeclared, which nothing provides.
  agent: Core.Agent.make({ use: [asking], program: (input: string) => Effect.succeed(input) }),
  provide: layer,
});
// A policy may need what its Step supplies, the Turn and the Scope, and nothing else.
const turnPolicy = Core.Extension.make("turn-policy", {
  policy: () => Effect.as(Core.Turn, "allow" as const),
});
const scopedPolicy = Core.Extension.make("scoped-policy", {
  policy: () =>
    Effect.as(
      Effect.addFinalizer(() => Effect.void),
      "allow" as const,
    ),
});
Core.Mitome.make({
  agent: Core.Agent.make({
    use: [turnPolicy, scopedPolicy],
    program: (input: string) => Effect.succeed(input),
  }),
});
const undeclaredPolicy = Core.Extension.make("undeclared-policy", {
  policy: () => Effect.as(Undeclared, "allow" as const),
});
Core.Mitome.make({
  // @ts-expect-error A policy needs Undeclared, which nothing provides.
  agent: Core.Agent.make({
    use: [undeclaredPolicy],
    program: (input: string) => Effect.succeed(input),
  }),
});

// An option `Mitome.make` does not know is refused, such as the field `provide` replaced.
Core.Mitome.make({
  agent: Core.Agent.make({ program: (input: string) => Effect.succeed(input) }),
  // @ts-expect-error `layer` is not an option of a Configuration.
  layer,
});
Core.Mitome.make({
  agent: Core.Agent.make({ program: (input: string) => Effect.succeed(input) }),
  // @ts-expect-error A misspelt option is refused.
  provides: layer,
});

// A Command's Scope is its own call's, so a Configuration need not provide it; another service
// the Command needs, it must.
const scopedCommand = Core.Extension.make("scoped-command", {
  commands: [
    Core.Command.make("scoped", {
      description: "Clean up after itself",
      run: () =>
        Effect.as(
          Effect.addFinalizer(() => Effect.void),
          Core.Command.reply(""),
        ),
    }),
  ],
});
Core.Mitome.make({
  agent: Core.Agent.make({
    use: [scopedCommand],
    program: (input: string) => Effect.succeed(input),
  }),
});
const scopedNeedy = Core.Extension.make("scoped-needy", {
  commands: [
    Core.Command.make("scoped", {
      description: "Clean up and read the Db",
      run: () =>
        Effect.as(
          Effect.zip(
            Effect.addFinalizer(() => Effect.void),
            Db,
          ),
          Core.Command.reply(""),
        ),
    }),
  ],
});
Core.Mitome.make({
  // @ts-expect-error The Command still needs Db.
  agent: Core.Agent.make({ use: [scopedNeedy], program: (input: string) => Effect.succeed(input) }),
});
Core.Mitome.make({
  agent: Core.Agent.make({ use: [scopedNeedy], program: (input: string) => Effect.succeed(input) }),
  provide: layer,
});

// A setup may need the Model a Provider supplies.
const modelled = Core.Extension.make("modelled", Effect.as(LanguageModel.LanguageModel, {}));
Core.Mitome.make({
  agent: Core.Agent.make({ use: [modelled] }),
  providers: [alpha],
  model: "alpha/known",
});

Core.Mitome.make({
  // @ts-expect-error A setup needs Clock, which nothing provides.
  agent: Core.Agent.make({ use: [notes], program: (input: string) => Effect.succeed(input) }),
});

Core.Mitome.make({
  agent: Core.Agent.make({ program: (input: string) => Effect.succeed(input) }),
  // @ts-expect-error What is provided may require nothing.
  provide: Layer.effect(Db, Effect.as(Undeclared, { label: "db" })),
});

// A list provides what each of its Layers provides, and fails as each of them fails.
const dbLayer: Layer.Layer<Db, DbError> = Layer.succeed(Db, { label: "db" });
const clockLayer = Layer.succeed(Clock, { now: 0 });
const listed = Core.Mitome.make({
  agent: Core.Agent.make({
    use: [notes],
    program: (input: string) => Effect.map(Db, ({ label }) => `${label}${input}`),
  }),
  provide: [dbLayer, clockLayer],
});
export const listContracts = [
  exact<NonNullable<typeof listed.provide>, readonly [typeof dbLayer, typeof clockLayer]>(true),
  exact<
    Effect.Error<ReturnType<typeof listed.acquire>>,
    DbError | Core.StepProtocolError | Core.ModelSelectionError
  >(true),
  exact<
    Effect.Error<ReturnType<Effect.Success<ReturnType<typeof listed.acquire>>["session"]>>,
    | Core.MitomeClosedError
    | NotesError
    | Core.ToolRegistrationError
    | Core.TranscriptError
    | Core.TranscriptSelectionError
  >(true),
];

// A list written inline infers from Layers built in place, without `as const` or a hoisted value,
// and still counts what each provides.
const closedLayer = (): Layer.Layer<never> => Layer.empty;
const inline = Core.Mitome.make({
  agent: Core.Agent.make({
    use: [notes],
    program: (input: string) => Effect.map(Db, ({ label }) => `${label}${input}`),
  }),
  provide: [
    Layer.sync(Db, () => ({ label: "db" })),
    Layer.succeed(Clock, { now: 0 }),
    Layer.effect(Undeclared, Effect.succeed({ n: 0 })),
    closedLayer(),
  ],
});
const inlineFailing = Core.Mitome.make({
  agent: Core.Agent.make({ program: (input: string) => Effect.succeed(input) }),
  provide: [Layer.effect(Clock, Effect.fail(new DbError())), dbLayer],
});
const inlineSingle = Core.Mitome.make({
  agent: Core.Agent.make({ use: [notes], program: (input: string) => Effect.succeed(input) }),
  provide: Layer.succeed(Clock, { now: 0 }),
});
export const inlineContracts = [
  // Each Layer is typed by its own arguments, not by the list it is written in.
  exact<
    NonNullable<typeof inline.provide>,
    readonly [Layer.Layer<Db>, Layer.Layer<Clock>, Layer.Layer<Undeclared>, Layer.Layer<never>]
  >(true),
  exact<
    Effect.Error<ReturnType<typeof inline.acquire>>,
    Core.StepProtocolError | Core.ModelSelectionError
  >(true),
  exact<
    Effect.Error<ReturnType<typeof inlineFailing.acquire>>,
    DbError | Core.StepProtocolError | Core.ModelSelectionError
  >(true),
  exact<NonNullable<typeof inlineSingle.provide>, Layer.Layer<Clock>>(true),
];
Core.Mitome.make({
  agent: Core.Agent.make({
    program: (input: string) => Effect.map(Db, ({ label }) => `${label}${input}`),
  }),
  provide: [closedLayer(), Layer.sync(Db, () => ({ label: "db" }))],
});
Core.Mitome.make({
  agent: Core.Agent.make({ program: (input: string) => Effect.succeed(input) }),
  provide: [Layer.sync(Db, () => ({ label: "db" }))],
});
Core.Mitome.make({
  // @ts-expect-error Db is provided only when its Layer is listed, even inline.
  agent: Core.Agent.make({ program: () => Effect.map(Db, ({ label }) => label) }),
  provide: [Layer.succeed(Clock, { now: 0 })],
});
Core.Mitome.make({
  agent: Core.Agent.make({ program: (input: string) => Effect.succeed(input) }),
  // @ts-expect-error Each Layer built in place may require nothing.
  provide: [Layer.effect(Clock, Effect.as(Undeclared, { now: 0 })), closedLayer()],
});

Core.Mitome.make({
  // @ts-expect-error Clock is provided only when its Layer is listed.
  agent: Core.Agent.make({ use: [notes], program: (input: string) => Effect.succeed(input) }),
  provide: [dbLayer],
});

Core.Mitome.make({
  agent: Core.Agent.make({ program: (input: string) => Effect.succeed(input) }),
  // @ts-expect-error A list is not empty.
  provide: [],
});

Core.Mitome.make({
  agent: Core.Agent.make({ program: (input: string) => Effect.succeed(input) }),
  // @ts-expect-error Each listed Layer may require nothing.
  provide: [dbLayer, Layer.effect(Clock, Effect.as(Undeclared, { now: 0 }))],
});

Core.Mitome.make({
  agent: Core.Agent.make({ program: (input: string) => Effect.succeed(input) }),
  // @ts-expect-error Beta's provisioning needs Clock, which nothing provides.
  providers: [beta],
  model: "beta/any",
});

Core.Mitome.make({
  agent: Core.Agent.make({ program: (input: string) => Effect.succeed(input) }),
  providers: [alpha],
  // @ts-expect-error A configured Model must name a declared Provider.
  model: "gamma/known",
});

Core.Mitome.make({
  // @ts-expect-error The parser's unsupplied service is not closed by anything.
  agent: Core.Agent.make({
    program: (input: string) => Effect.succeed(input),
    text: { parse: (text: string) => Effect.as(Undeclared, text), render: Effect.succeed },
  }),
  provide: layer,
});

Core.Mitome.make({
  // @ts-expect-error The renderer's Db is provided only by a Layer this Configuration lacks.
  agent: Core.Agent.make({
    program: (input: string) => Effect.succeed(input),
    text: { parse: Effect.succeed, render: (result: string) => Effect.as(Db, result) },
  }),
});
