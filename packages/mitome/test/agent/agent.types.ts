// Compile-only fixture: the @ts-expect-error lines are the negative controls, so the language
// service's duplicate context/error diagnostics are skipped here.
// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file missingEffectError:skip-file missingLayerContext:skip-file */
import { Context, Effect, Schema } from "effect";
import type { Scope, Types } from "effect";
import { LanguageModel, Tool, Toolkit } from "effect/ai";
import type { AiError } from "effect/ai";
import type {
  ModelRequestAccounting,
  CommandFailedError,
  CommandNotFoundError,
  SessionBusyError,
  SessionFencedError,
  SessionReleasedError,
  SessionSaveError,
  ToolRegistrationError,
  TranscriptError,
  TranscriptSelectionError,
} from "../../src/index.js";
import { Agent, Command, Extension, Session, Turn } from "../../src/index.js";

const exact = <X, Y>(equal: Types.Equals<X, Y>) => equal;

class Store extends Context.Service<Store, { readonly add: (text: string) => void }>()(
  "fixture/Store",
) {}
class Disk extends Context.Service<Disk, { readonly path: string }>()("fixture/Disk") {}
class Rules extends Context.Service<Rules, { readonly strict: boolean }>()("fixture/Rules") {}
class Clock extends Context.Service<Clock, { readonly now: number }>()("fixture/Clock") {}
class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {}) {}
class Full extends Schema.TaggedError<Full, { readonly brand: unique symbol }>()("Full", {}) {}

const Add = Tool.make("add", {
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.String,
  failure: Full,
});
const Fetch = Tool.make("fetch", {
  parameters: Schema.Struct({ url: Schema.String }),
  success: Schema.String,
  failureMode: "return",
});

const NotesKit = Toolkit.make(Add);

// A setup needs Disk from outside and may fail; its Scope is the Session's own. Its policy needs
// Rules and its Command needs Clock, from outside too; the handlers close over its state.
const notes = Extension.make(
  "notes",
  Effect.gen(function* () {
    const disk = yield* Disk;
    if (disk.path === "") {
      return yield* new StoreError();
    }
    yield* Effect.addFinalizer(() => Effect.void);
    const added: Array<string> = [];
    return {
      tools: NotesKit,
      handlers: NotesKit.of({ add: ({ text }) => Effect.sync(() => (added.push(text), text)) }),
      // Extension policies see untyped calls: the Tool may belong to another Extension.
      policy: (call: Extension.ToolCall) =>
        Effect.map(Rules, (rules) =>
          rules.strict && call.name !== "add" ? ("ask" as const) : ("allow" as const),
        ),
      commands: [
        Command.make("notes", {
          description: "List the notes",
          run: () => Effect.as(Clock, Command.reply(added.join(", "))),
        }),
      ],
    };
  }),
);
const web = Extension.make("web", {
  tools: Toolkit.make(Fetch),
  handlers: { fetch: ({ url }) => Effect.succeed(url) },
  instructions: "Cite every page.",
});

export const extensionContracts = [
  exact<
    typeof notes,
    Extension.Extension<{ readonly add: typeof Add }, StoreError, Disk | Rules | Clock>
  >(true),
  exact<typeof web, Extension.Extension<{ readonly fetch: typeof Fetch }>>(true),
];

// The policy a record exposes still says what it needs at its Step, the Turn and the Scope, while
// the Extension's `R` leaves them out; so does the policy of a record a setup returns.
const turnPolicy = (call: Extension.ToolCall) =>
  Effect.map(Turn, (turn) =>
    turn.id === call.toolCallId ? ("deny" as const) : ("allow" as const),
  );
const steady = Extension.make("steady", { policy: turnPolicy });
const steadySetup = Extension.make("steady", Effect.succeed({ policy: turnPolicy }));
declare const steadyRecord: Exclude<(typeof steady)["parts"], Effect.Effect<any, any, any>>;
declare const steadySetupRecord: Effect.Success<
  Extract<(typeof steadySetup)["parts"], Effect.Effect<any, any, any>>
>;
export const policyContracts = [
  exact<typeof steady, Extension.Extension<{}, never, never>>(true),
  exact<typeof steadySetup, Extension.Extension<{}, never, never>>(true),
  exact<
    Effect.Services<ReturnType<NonNullable<(typeof steadyRecord)["policy"]>>>,
    Turn | Scope.Scope
  >(true),
  exact<
    Effect.Services<ReturnType<NonNullable<(typeof steadySetupRecord)["policy"]>>>,
    Turn | Scope.Scope
  >(true),
];

// A setup or a Command never has a Turn: requiring one fails where it is defined, while an optional
// lookup compiles.
Extension.make(
  "turned",
  // @ts-expect-error A setup has no Turn.
  Effect.as(Turn, {}),
);
// @ts-expect-error A Command has no Turn.
Command.make("turned", {
  description: "Needs a Turn",
  run: () => Effect.as(Turn, Command.reply("")),
});
export const optionalTurn = [
  Extension.make("optional", Effect.as(Effect.serviceOption(Turn), {})),
  Command.make("optional", {
    description: "Looks for a Turn",
    run: () => Effect.as(Effect.serviceOption(Turn), Command.reply("")),
  }),
];

// The default program: string in, the final text out, everything the loop needs left open.
const plain = Agent.make({ instructions: "Be brief.", use: [notes, web] });
const plainSession = Session.make(plain);
type PlainSession = Effect.Success<typeof plainSession>;
const continued = Session.make(plain, { transcript: { latest: "/work" } });

export const defaultContracts = [
  exact<Parameters<PlainSession["run"]>[0], string>(true),
  exact<Effect.Success<ReturnType<PlainSession["run"]>>, string>(true),
  exact<
    Effect.Services<ReturnType<PlainSession["run"]>>,
    LanguageModel.LanguageModel | ModelRequestAccounting
  >(true),
  // Making the Session runs the setups, registers the Tools once and opens its Transcript; what
  // the setups, policies and Commands need is needed here.
  exact<
    Effect.Error<typeof plainSession>,
    StoreError | ToolRegistrationError | TranscriptError | TranscriptSelectionError
  >(true),
  exact<Effect.Services<typeof plainSession>, Scope.Scope | Disk | Rules | Clock>(true),
  exact<
    PlainSession["commands"],
    ReadonlyArray<{
      readonly name: string;
      readonly description: string;
      readonly extension: string;
    }>
  >(true),
  exact<
    ReturnType<PlainSession["command"]>,
    Effect.Effect<Command.Result, CommandNotFoundError | CommandFailedError | SessionReleasedError>
  >(true),
  // Selecting a stored conversation changes nothing else about the Session.
  exact<typeof continued, typeof plainSession>(true),
  exact<Parameters<PlainSession["moveTo"]>, [position: string | undefined]>(true),
  exact<
    Effect.Error<ReturnType<PlainSession["moveTo"]>>,
    | SessionBusyError
    | SessionReleasedError
    | TranscriptError
    | SessionSaveError
    | SessionFencedError
  >(true),
];
// @ts-expect-error A selection names one of create, latest or open.
const unknownSelection = Session.make(plain, { transcript: { resume: "/work" } });
// @ts-expect-error A selection names exactly one of them: a spread default cannot win over `open`.
const mixedSelection = Session.make(plain, { transcript: { create: "", open: "t0" } });
void [unknownSelection, mixedSelection];
type PlainRunError = Effect.Error<ReturnType<PlainSession["run"]>>;
// The error-mode Tool's failure reaches the program; the return-mode Tool's does not.
export const plainErrors = [
  exact<Extract<PlainRunError, Full>, Full>(true),
  exact<
    Extract<PlainRunError, SessionBusyError | SessionReleasedError | AiError.AiError>,
    SessionBusyError | SessionReleasedError | AiError.AiError
  >(true),
  // A commit can fail inside a Step or at the Turn's end.
  exact<
    Extract<PlainRunError, SessionSaveError | SessionFencedError>,
    SessionSaveError | SessionFencedError
  >(true),
];

// A custom program with its own input and result composes with `use` through `steps`.
const custom = Agent.make({
  use: [notes, web],
  // The Agent's own policy sees the merged Tools' typed calls.
  policy: (call) =>
    Effect.succeed(call.name === "add" && call.params.text.length > 100 ? "deny" : "allow"),
  program: (input: { readonly topic: string }, { loop }) =>
    Effect.gen(function* () {
      const turn = yield* Turn;
      const result = yield* loop;
      return { turn: turn.id, length: result.response.text.length + input.topic.length };
    }),
  text: {
    parse: (text) => Effect.succeed({ topic: text }),
    render: (result) => Effect.succeed(`${result.length}`),
  },
});
const customSession = Session.make(custom);
type CustomSession = Effect.Success<typeof customSession>;
export const customContracts = [
  exact<Parameters<CustomSession["run"]>[0], { readonly topic: string }>(true),
  exact<Effect.Success<ReturnType<CustomSession["run"]>>, { turn: string; length: number }>(true),
  exact<
    Effect.Services<ReturnType<CustomSession["run"]>>,
    LanguageModel.LanguageModel | ModelRequestAccounting
  >(true),
];

// Overriding part of an Agent through `make` keeps every type.
const overridden = Agent.make({ ...custom, instructions: "Be thorough." });
export const overrideContracts = [exact<typeof overridden, typeof custom>(true)];

// A program that ignores `steps` is the ordinary function.
const ordinary = Agent.make({
  program: (input: string) => Effect.map(Store, () => input.length),
  text: { parse: Effect.succeed, render: (n) => Effect.succeed(`${n}`) },
});
const ordinarySession = Session.make(ordinary);
export const ordinaryContracts = [
  exact<Effect.Services<ReturnType<Effect.Success<typeof ordinarySession>["run"]>>, Store>(true),
  exact<Effect.Services<typeof ordinarySession>, Scope.Scope>(true),
  // The root Session.make returns its namespace's Session, with the Agent's input, result and error.
  exact<Effect.Success<typeof ordinarySession>, Session.Session<string, number, never, Store>>(
    true,
  ),
];

// @ts-expect-error A program whose result is not a string needs a text mapping.
Agent.make({ program: (input: string) => Effect.succeed(input.length) });

// @ts-expect-error The identity parses any text, so a program taking only some strings needs a mapping.
Agent.make({ program: (input: "yes" | "no") => Effect.succeed(input) });

// @ts-expect-error Without a program the errors and requirements are the default loop's, not none.
export const modelFree: Agent.Agent<string, string, never, never> = Agent.make({});

// @ts-expect-error Choosing the types explicitly does not drop the program they describe.
Agent.make<readonly [], never, string, string, never, never, never, never, never, never>({});

Agent.make({
  program: (input: string) => Effect.succeed(input.length),
  // @ts-expect-error The renderer receives the program's result.
  text: { parse: Effect.succeed, render: (result: string) => Effect.succeed(result) },
});

Agent.make({
  use: [notes],
  // @ts-expect-error The Agent's policy sees only the merged Tools' parameters.
  policy: (call) => Effect.succeed(call.params.url === "" ? "deny" : "allow"),
});

Agent.make({
  // The Tools a setup returns reach the Agent's policy typed.
  use: [notes],
  policy: (call) => Effect.succeed(call.params.text === "" ? "deny" : "allow"),
});

Extension.make("typo", {
  tools: Toolkit.make(Add),
  // @ts-expect-error Handlers are checked against the Toolkit.
  handlers: { add: ({ url }: { url: string }) => Effect.succeed(url) },
});

Extension.make(
  "typo",
  // @ts-expect-error Handlers a setup returns are checked against its Toolkit.
  Effect.succeed({
    tools: Toolkit.make(Add),
    handlers: { add: ({ url }: { url: string }) => Effect.succeed(url) },
  }),
);

Extension.make("missing", {
  tools: Toolkit.make(Add),
  // @ts-expect-error The handlers bind every Tool of the Toolkit.
  handlers: {},
});

Extension.make(
  "missing",
  // @ts-expect-error A setup's handlers bind every Tool of its Toolkit.
  Effect.succeed({ tools: Toolkit.make(Add), handlers: {} }),
);

// A setup may need the Model; making the Session then needs it, and `run` still needs its own.
const planner = Extension.make("planner", Effect.as(LanguageModel.LanguageModel, {}));
const plannerSession = Session.make(Agent.make({ use: [planner] }));
export const modelContracts = [
  exact<Effect.Services<typeof plannerSession>, Scope.Scope | LanguageModel.LanguageModel>(true),
  exact<
    Effect.Services<ReturnType<Effect.Success<typeof plannerSession>["run"]>>,
    LanguageModel.LanguageModel | ModelRequestAccounting
  >(true),
];

// Limits are optional, and one bound may be given alone.
const unlimited = Agent.make({});
export const oneBound = Agent.make({ limits: { generations: 1 } });
exact<typeof oneBound, typeof unlimited>(true);

// The root Session.make takes only an Agent; a Session without one is the kernel's.
const kernelOptions = { transcript: "none", limits: { generations: 1, dispatches: 1 } } as const;
// @ts-expect-error Session options are not an Agent.
export const notAnAgent = Session.make(kernelOptions);
