import { Cause, Context, Data, Effect, Fiber, Layer, Predicate, Schema, Stream } from "effect";
import { AiError, LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/ai";
import {
  ExecutionLimitError,
  IncompleteStepError,
  type SessionReleasedError,
  StepProtocolError,
  ToolRegistrationError,
} from "./errors.js";
import { Turn, turnControl } from "./session.js";
import type { TurnControl } from "./session.js";

/**
 * A Model binding's declaration that, while `model` runs a controlled generation, it calls
 * `reportModelRequest` immediately before sending each physical Provider request, including its
 * own retries and native fallback. A controlled Step requires it and refuses to generate when it
 * names a different `LanguageModel` than the one in use, so unaccounted bindings are rejected
 * before any request rather than run with unknown accounting. Build it with
 * `withModelRequestAccounting`; the declaration is the binding author's, qualified by tests.
 */
export class ModelRequestAccounting extends Context.Service<
  ModelRequestAccounting,
  {
    /** Which binding made the declaration, for diagnostics. */
    readonly binding: string;
    /** The exact Model instance whose requests are reported. */
    readonly model: LanguageModel.LanguageModel;
  }
>()("@mitome/core/ModelRequestAccounting") {}

/**
 * Adds a `ModelRequestAccounting` declaration for the `LanguageModel` a binding Layer builds,
 * keeping every other service that Layer provides, with its error and requirements.
 */
export const withModelRequestAccounting = <ROut, E, R>(
  binding: string,
  layer: Layer.Layer<ROut | LanguageModel.LanguageModel, E, R>,
): Layer.Layer<ROut | LanguageModel.LanguageModel | ModelRequestAccounting, E, R> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer);
      const model = Context.get(context, LanguageModel.LanguageModel);
      return Context.add(context, ModelRequestAccounting, { binding, model });
    }),
  );

/** The Turns whose controlled Step the current fiber is running inside, including its callbacks. */
const enteredSteps = Context.Reference<ReadonlySet<Turn["Service"]>>(
  "@mitome/core/EnteredControlledSteps",
  { defaultValue: () => new Set() },
);

const currentGeneration = Context.Reference<{ requests: number } | undefined>(
  "@mitome/core/CurrentControlledGeneration",
  { defaultValue: () => undefined },
);

/**
 * Counts one physical Provider request against the controlled generation in progress on this
 * fiber. Outside a controlled generation it does nothing.
 */
export const reportModelRequest: Effect.Effect<void> = Effect.gen(function* () {
  const generation = yield* currentGeneration;
  if (generation !== undefined) generation.requests += 1;
});

/** One local Tool Call as policy and consent see it, with its once-decoded parameters. */
export type ToolCallRequest<Tools extends Record<string, Tool.Any>> = {
  readonly [Name in keyof Tools]: {
    readonly toolCallId: string;
    readonly name: Name;
    readonly params: Tool.Parameters<Tools[Name]>;
  };
}[keyof Tools];

/** Checks one decoded call immediately before its handler; a denial is a native `AiError`. */
type Gate<Tools extends Record<string, Tool.Any>> = (
  request: ToolCallRequest<Tools>,
) => Effect.Effect<void, AiError.AiError>;

/** A handler map built key by key before it is handed to native `toHandlers`. */
type GatedHandlers<Tools extends Record<string, Tool.Any>> = {
  -readonly [Name in keyof Toolkit.HandlersFrom<Tools>]: Toolkit.HandlersFrom<Tools>[Name];
};

const RegistrationId: unique symbol = Symbol("@mitome/core/LocalTools");

/** How a controlled Step reaches registered handlers; not for application use. */
export interface Registration<Tools extends Record<string, Tool.Any>> {
  /** Author handlers wrapped so each checks `gate` with the value native handling decoded. */
  readonly gated: (gate: Gate<Tools>) => Toolkit.HandlersFrom<Tools>;
  /** Services the handlers captured when they were registered. */
  readonly context: Context.Context<never>;
}

/**
 * Native Tools with their handlers, registered once for controlled Steps. The handlers are
 * reachable only through controlled dispatch, not through this value's public fields.
 */
export interface LocalTools<Tools extends Record<string, Tool.Any>> {
  readonly toolkit: Toolkit.Toolkit<Tools>;
  /** @internal */
  readonly [RegistrationId]: Registration<Tools>;
}

/**
 * Registers native Tools with an ordinary handler map or an Effect building one. The builder runs
 * once, here, and its handlers keep the services it captured; each dispatch still runs with the
 * invoking Turn's services and Scope in precedence. Rejects Tool names that disagree with their
 * keys, duplicate ids, missing or extra handlers, and Tool variants a controlled Step cannot
 * yet authorize (provider-defined and dynamic Tools). Duplicate names that `Toolkit.make`
 * already discarded cannot be detected.
 */
export const localTools = <Tools extends Record<string, Tool.Any>, EX = never, RX = never>(
  toolkit: Toolkit.Toolkit<Tools>,
  build: Toolkit.HandlersFrom<Tools> | Effect.Effect<Toolkit.HandlersFrom<Tools>, EX, RX>,
): Effect.Effect<LocalTools<Tools>, EX | ToolRegistrationError, RX> =>
  Effect.gen(function* () {
    const ids = new Set<string>();
    for (const [key, tool] of Object.entries(toolkit.tools)) {
      if (key !== tool.name || ids.has(tool.id)) {
        return yield* new ToolRegistrationError({ detail: `Ambiguous Tool binding "${key}"` });
      }
      if (Tool.isProviderDefined(tool) || Tool.isDynamic(tool)) {
        return yield* new ToolRegistrationError({
          detail: `Tool "${key}" is not an ordinary Effect-Schema Tool`,
        });
      }
      ids.add(tool.id);
    }
    const context = yield* Effect.context<RX>();
    const built = Effect.isEffect(build) ? yield* build : build;
    // Snapshot the author's own bindings once; later changes to their map are not seen.
    const handlers = { ...built };
    const names = Object.keys(toolkit.tools);
    if (
      Object.keys(handlers).length !== names.length ||
      !names.every((name) => Object.hasOwn(handlers, name))
    ) {
      return yield* new ToolRegistrationError({
        detail: "Handlers must match the Toolkit's Tools exactly",
      });
    }
    const gated = (gate: Gate<Tools>) => {
      // SAFETY: filled below with a wrapper for every own handler key checked against the Toolkit.
      const output = {} as GatedHandlers<Tools>;
      // SAFETY: the own keys of `handlers` were just checked to be exactly the Toolkit's Tool names.
      for (const name of Object.keys(handlers) as Array<keyof Toolkit.HandlersFrom<Tools>>) {
        const handler = handlers[name];
        output[name] = (params, handlerContext) =>
          Effect.flatMap(
            // `params` is the value native handling decoded for this handler's own Tool.
            gate({ toolCallId: handlerContext.toolCallId ?? "", name, params }),
            () => handler(params, handlerContext),
          );
      }
      // SAFETY: a fully populated mutable copy of the same mapped handler type.
      return output as Toolkit.HandlersFrom<Tools>;
    };
    const registered: LocalTools<Tools> = { toolkit, [RegistrationId]: { gated, context } };
    Object.defineProperty(registered, RegistrationId, { enumerable: false });
    return registered;
  });

/** An author decision for one Tool Call. `ask` requires consent; missing consent denies. */
export type ToolDecision = "allow" | "ask" | "deny";

/** Options for one controlled Step. `R` is what its policy, consent and authority checks need. */
export interface StepOptions<Tools extends Record<string, Tool.Any>, R = never> {
  /** The Tools exposed to the Model; only these calls are dispatched locally. */
  readonly tools?: LocalTools<Tools>;
  /** Static Instructions prepended to this Step's Model Prompt as a system Message; never staged. */
  readonly instructions?: string;
  /** Native Tool-choice intent. It is not authority and does not replace output validation. */
  readonly toolChoice?: LanguageModel.GenerateTextOptions<Tools>["toolChoice"];
  /**
   * Decides each call once, after its parameters are decoded. Without it a Tool's own
   * `needsApproval` asks. A failure or defect denies.
   */
  readonly policy?: (call: ToolCallRequest<Tools>) => Effect.Effect<ToolDecision, unknown, R>;
  /** Grants or refuses consent for one exact call and its decoded parameters. A failure refuses. */
  readonly consent?: (call: ToolCallRequest<Tools>) => Effect.Effect<boolean, unknown, R>;
  /**
   * Rechecks that the call is still permitted immediately before its handler runs, after any
   * consent wait: revocation, a fence or cancellation decided elsewhere. It is not a second risk
   * decision and sees the same decoded parameters. `false` or a failure denies.
   */
  readonly authority?: (call: ToolCallRequest<Tools>) => Effect.Effect<boolean, unknown, R>;
}

type StepResultCases<Tools extends Record<string, Tool.Any>> = Data.TaggedEnum<{
  /**
   * The Model response is complete. `response` is the original native response; `results` are
   * this Step's separately resolved local Tool results, which the response's own getters do not
   * include. Its conversation contribution has been staged.
   */
  Complete: {
    readonly response: LanguageModel.GenerateTextResponse<Tools, "encoded">;
    readonly results: ReadonlyArray<Response.ToolResultParts<Tools>>;
  };
  /**
   * The Model response explicitly reports it is incomplete. No local Tool ran and nothing was
   * staged; the program decides what to do next.
   */
  Incomplete: {
    readonly response: LanguageModel.GenerateTextResponse<Tools, "encoded">;
    /** The explicit finish reason. */
    readonly reason: Response.FinishReason;
  };
}>;

/** A Step whose Model response is complete. */
export type CompleteStep<Tools extends Record<string, Tool.Any>> = Extract<
  StepResult<Tools>,
  { readonly _tag: "Complete" }
>;
/** A Step whose Model response is explicitly incomplete. */
export type IncompleteStep<Tools extends Record<string, Tool.Any>> = Extract<
  StepResult<Tools>,
  { readonly _tag: "Incomplete" }
>;

interface StepResultDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: StepResultCases<Extract<this["A"], Record<string, Tool.Any>>>;
}

/** The outcome of a successfully returned controlled Step. */
export type StepResult<Tools extends Record<string, Tool.Any>> = Data.TaggedEnum.Kind<
  StepResultDefinition,
  Tools
>;
const { Complete, Incomplete } = Data.taggedEnum<StepResultDefinition>();

const denial = (description: string) =>
  AiError.make({
    module: "@mitome/core",
    method: "step",
    reason: new AiError.UnknownError({ description }),
  });

const protocol = (reason: StepProtocolError["reason"], detail: string) =>
  new StepProtocolError({ reason, detail });

const hasApprovalArtifact = (prompt: Prompt.Prompt) =>
  prompt.content.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some(
        (part: { readonly type: string }) =>
          part.type === "tool-approval-request" || part.type === "tool-approval-response",
      ),
  );

interface Classified {
  /** The explicit incomplete finish reason, when the response is incomplete. */
  readonly incomplete: Response.FinishReason | undefined;
  /** Local calls to dispatch, in response order. */
  readonly calls: ReadonlyArray<Response.ToolCallPart<string, unknown>>;
}

/**
 * Validates the whole response before anything local runs; never trusts the first-finish getter.
 * Contradictory data is malformed even in an incomplete response. Only local Tools are exposed
 * (native decoding rejects calls to any other name), so a Provider-executed call or a Tool result
 * inside the response can only be contradictory: remote capabilities need their own pre-request
 * grants, which controlled Steps do not yet support.
 */
const classify = (
  content: ReadonlyArray<Response.AnyPart>,
): Effect.Effect<Classified, StepProtocolError> =>
  Effect.gen(function* () {
    const finishes = content.filter((part) => part.type === "finish");
    if (finishes.length > 1) {
      return yield* protocol("malformed-response", "Response has more than one finish part");
    }
    if (content.some((part) => part.type === "tool-approval-request")) {
      return yield* protocol(
        "unsupported-continuation",
        "Provider-deferred approval is not supported",
      );
    }
    const calls: Array<Response.ToolCallPart<string, unknown>> = [];
    const ids = new Set<string>();
    for (const part of content) {
      if (part.type === "tool-result") {
        return yield* protocol(
          "malformed-response",
          `Response carries a result for Tool Call "${part.id}"`,
        );
      }
      if (part.type !== "tool-call") continue;
      if (ids.has(part.id)) {
        return yield* protocol("malformed-response", `Duplicate Tool Call id "${part.id}"`);
      }
      if (part.providerExecuted) {
        return yield* protocol(
          "malformed-response",
          `Provider claims to have executed local Tool "${part.name}"`,
        );
      }
      ids.add(part.id);
      calls.push(part);
    }
    const finish = finishes[0];
    if (finish?.reason === "pause") {
      return yield* protocol("unsupported-continuation", "Provider paused the response");
    }
    if (finish !== undefined && finish.reason !== "stop" && finish.reason !== "tool-calls") {
      return { incomplete: finish.reason, calls: [] };
    }
    if (finish?.reason === "tool-calls" && calls.length === 0) {
      return yield* protocol("malformed-response", "Finish reports Tool Calls but has none");
    }
    return { incomplete: undefined, calls };
  });

/** Runs `operation` on its own child fiber and waits for it, including when interrupted. */
const owned = <A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const child = yield* Effect.forkChild(restore(operation));
      return yield* restore(Fiber.join(child)).pipe(Effect.ensuring(Fiber.interrupt(child)));
    }),
  );

/** Whether a Tool's own risk flag asks for consent; a failing predicate denies. */
const toolDefault = <Tools extends Record<string, Tool.Any>>(
  tool: Tool.Any,
  request: ToolCallRequest<Tools>,
  prompt: Prompt.Prompt,
): Effect.Effect<ToolDecision, unknown> => {
  const needsApproval = tool.needsApproval;
  if (needsApproval === undefined || needsApproval === false) return Effect.succeed("allow");
  if (needsApproval === true) return Effect.succeed("ask");
  return Effect.suspend(() => {
    const flagged = needsApproval(request.params, {
      toolCallId: request.toolCallId,
      messages: prompt.content,
    });
    return Effect.isEffect(flagged) ? flagged : Effect.succeed(flagged);
  }).pipe(Effect.map((flagged): ToolDecision => (flagged ? "ask" : "allow")));
};

/**
 * Fails closed on anything but interruption, which stays native. Callers suspend the callback so a
 * synchronous throw is a defect here, not before this boundary. A Cause without interruption
 * (failures, defects or both) denies. A Cause with interruption propagates whole, every reason in
 * order with its annotations; its typed failures become defects of the same value (owner decision:
 * the callbacks' error type is not part of a Step's), the one exception to keeping failure tags.
 */
const orDeny = <A, E>(effect: Effect.Effect<A, E>, denied: A): Effect.Effect<A> =>
  Effect.catchCause(effect, (cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(
          Cause.fromReasons(
            cause.reasons.map((reason) =>
              Cause.isFailReason(reason)
                ? Cause.makeDieReason(reason.error).annotate(Cause.reasonAnnotations(reason))
                : reason,
            ),
          ),
        )
      : Effect.succeed(denied),
  );

const dispatch = <Tools extends Record<string, Tool.Any>, R>(
  registered: LocalTools<Tools>,
  options: StepOptions<Tools, R>,
  control: TurnControl,
  prompt: Prompt.Prompt,
  call: Response.ToolCallPart<string, unknown>,
) =>
  Effect.gen(function* () {
    const { gated, context } = registered[RegistrationId];
    const tools: Record<string, Tool.Any> = registered.toolkit.tools;
    // Policy, consent and authority run inside the handler with the Step caller's services.
    const services = yield* Effect.context<R>();
    const withServices = <A, E>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideContext(effect, services);
    let refused: ExecutionLimitError | undefined;
    const gate: Gate<Tools> = (request) =>
      Effect.gen(function* () {
        // The only permitted entry is this Step's call, with the value native handling decoded.
        if (request.name !== call.name || request.toolCallId !== call.id) {
          return yield* denial("Tool call is not the one this Step dispatched");
        }
        const tool = tools[call.name];
        if (tool === undefined)
          return yield* denial("Tool call is not the one this Step dispatched");
        const { policy, consent, authority } = options;
        const decision = yield* orDeny(
          policy === undefined
            ? toolDefault(tool, request, prompt)
            : withServices(Effect.suspend(() => policy(request))),
          "deny",
        );
        if (decision === "deny") return yield* denial("Tool call was denied by policy");
        if (decision === "ask") {
          const granted =
            consent !== undefined &&
            (yield* orDeny(withServices(Effect.suspend(() => consent(request))), false));
          if (!granted) return yield* denial("Tool call did not receive consent");
        }
        // Current authority after any wait. Interruption of the owning Turn stays native.
        if (
          authority !== undefined &&
          !(yield* orDeny(withServices(Effect.suspend(() => authority(request))), false))
        ) {
          return yield* denial("Tool call is no longer authorized");
        }
        yield* control.reserve("dispatches").pipe(
          Effect.catchTag("ExecutionLimitError", (error) => {
            refused = error;
            return Effect.fail(denial("Turn reached its local Tool dispatch limit"));
          }),
        );
      });
    const exit = yield* Effect.exit(
      owned(
        Effect.gen(function* () {
          const handlerContext = yield* registered.toolkit
            .toHandlers(gated(gate))
            .pipe(Effect.provideContext(context));
          const ready = yield* registered.toolkit.pipe(Effect.provideContext(handlerContext));
          // Consume the whole result Stream so handler work and cleanup settle here.
          const stream = yield* ready.handle(
            call.name,
            // SAFETY: encoded parameters of this registered Tool from the schema-decoded response.
            call.params as Tool.ParametersEncoded<Tools[keyof Tools]>,
            call.id,
          );
          const outputs = yield* Stream.runCollect(stream);
          const final = Array.from(outputs).findLast((output) => !output.preliminary);
          if (final === undefined) return yield* Effect.die(new Error("Tool produced no result"));
          return Response.makePart("tool-result", {
            id: call.id,
            name: call.name,
            result: final.result,
            encodedResult: final.encodedResult,
            isFailure: final.isFailure,
            providerExecuted: false,
            preliminary: false,
          });
        }),
      ),
    );
    if (refused !== undefined) return yield* refused;
    // SAFETY: the part pairs this registered Tool's name with its native, validated result.
    const part = (yield* exit) as Response.ToolResultParts<Tools>;
    // Recorded before the Step advances, so it survives a later call's failure.
    yield* control.recordOutcome(registered, part);
    return part;
  });

/**
 * The local Tool results this Turn's controlled Steps have produced through `tools`, in dispatch
 * order, including those of a Step that failed at a later call. They are the same native results a
 * completed Step returns, read from the Turn's own execution record; a later call's failure stays
 * that Step's failure. Readable while the Turn's Session lives, including after the Turn ends,
 * and failing with `SessionReleasedError` once it is released. Reading keeps nothing alive and
 * the records are not durable.
 */
export const toolOutcomes = <Tools extends Record<string, Tool.Any>>(
  tools: LocalTools<Tools>,
): Effect.Effect<ReadonlyArray<Response.ToolResultParts<Tools>>, SessionReleasedError, Turn> =>
  Effect.gen(function* () {
    const turn = yield* Turn;
    const parts = yield* turnControl(turn).outcomes(tools);
    // SAFETY: parts are recorded under a registration only by its own dispatches, each a native
    // result of one of that registration's Tools, and `tools` is that registration.
    return parts as ReadonlyArray<Response.ToolResultParts<Tools>>;
  });

/**
 * Performs one controlled Step in the current Turn. Builds the Model Prompt from any
 * Instructions, committed history and this Turn's staged Messages, checks that the Model's
 * requests are accounted for, reserves one generation, generates without native Tool resolution
 * and validates the whole response. An explicitly incomplete response returns `Incomplete` with
 * nothing run or staged. Otherwise its local Tool Calls run one at a time, each decided once and
 * dispatched only after its handler work and result Stream finish, and the response with those
 * results is staged. Native approval artifacts in the Prompt are rejected before generation.
 * Provider, handler and codec failures, defects and interruption propagate unchanged; library
 * denials are native `AiError`s the Tool's failure mode handles.
 */
export const step = <Tools extends Record<string, Tool.Any> = {}, R = never>(
  options: StepOptions<Tools, R> = {},
): Effect.Effect<
  StepResult<Tools>,
  | AiError.AiError
  | Schema.SchemaError
  | StepProtocolError
  | ExecutionLimitError
  | Tool.HandlerError<Tools[keyof Tools]>,
  | LanguageModel.LanguageModel
  | ModelRequestAccounting
  | Turn
  | Tool.HandlerServices<Tools[keyof Tools]>
  // Native generation with Tool resolution disabled may encode parameters, so the parameter codec's
  // encoding services stay a requirement.
  | Tool.ParametersEncodingServices<Tools[keyof Tools]>
  | R
> =>
  Effect.gen(function* () {
    const turn = yield* Turn;
    const control = turnControl(turn);
    const entered = yield* enteredSteps;
    // A Step's own callbacks (Model, policy, consent, authority, handlers) run while it holds its
    // Turn's permit; starting another Step of that Turn from them would wait for itself forever.
    if (entered.has(turn)) {
      return yield* Effect.die(
        new Error("A controlled Step cannot start another Step of its Turn from its own callbacks"),
      );
    }
    return yield* control
      .admit(admitted(turn, control, options))
      .pipe(Effect.provideService(enteredSteps, new Set([...entered, turn])));
  });

/** The whole controlled Step, run once its Turn has admitted it. */
const admitted = <Tools extends Record<string, Tool.Any>, R>(
  turn: Turn["Service"],
  control: TurnControl,
  options: StepOptions<Tools, R>,
) =>
  Effect.gen(function* () {
    const model = yield* LanguageModel.LanguageModel;
    const accounting = yield* ModelRequestAccounting;
    if (accounting.model !== model) {
      return yield* protocol(
        "unsupported-accounting",
        `Request accounting from "${accounting.binding}" does not cover the Model in use`,
      );
    }
    const conversation = yield* control.prompt;
    if (hasApprovalArtifact(conversation)) {
      return yield* protocol("approval-artifact", "Prompt carries native approval parts");
    }
    const prompt =
      options.instructions === undefined
        ? conversation
        : Prompt.concat(
            Prompt.fromMessages([Prompt.systemMessage({ content: options.instructions })]),
            conversation,
          );
    // SAFETY: without a registration no Tools are exposed; the empty record is the default `{}`.
    const tools = (options.tools?.toolkit.tools ?? {}) as Tools;
    // Native handling can never dispatch through this toolkit: controlled dispatch is below.
    const toolkit: Toolkit.WithHandler<Tools> = {
      tools,
      handle: () => Effect.die(new Error("Controlled Steps dispatch Tools themselves")),
    };
    yield* control.reserve("generations");
    const generation = { requests: 0 };
    const response = yield* model
      .generateText({
        prompt,
        toolkit,
        toolChoice: options.toolChoice,
        disableToolCallResolution: true,
      })
      .pipe(
        Effect.provideService(currentGeneration, generation),
        Effect.ensuring(Effect.suspend(() => control.addPhysicalRequests(generation.requests))),
      );
    const classified = yield* classify(response.content);
    if (classified.incomplete !== undefined) {
      return Incomplete({ response, reason: classified.incomplete });
    }
    const results: Array<Response.ToolResultParts<Tools>> = [];
    const registered = options.tools;
    if (registered !== undefined) {
      for (const call of classified.calls) {
        results.push(yield* dispatch(registered, options, control, prompt, call));
      }
    }
    // Conversation projection only: a top-level undefined encoded result (the native encoding of
    // `Schema.Void`) has no JSON form, so Providers and the Transcript receive null. The returned
    // and recorded results keep their native values.
    const projected = results.map((part) =>
      part.encodedResult === undefined ? { ...part, encodedResult: null } : part,
    );
    yield* turn.stage(...Prompt.fromResponseParts([...response.content, ...projected]).content);
    return Complete({ response, results });
  });

/**
 * The default loop: repeats `step` while the previous Step resolved local Tool Calls and returns
 * the final completed Step. An incomplete response fails with `IncompleteStepError`; reaching an
 * execution limit fails with that Step's `ExecutionLimitError`.
 */
export const loop = <Tools extends Record<string, Tool.Any> = {}, R = never>(
  options: StepOptions<Tools, R> = {},
): Effect.Effect<
  CompleteStep<Tools>,
  | AiError.AiError
  | Schema.SchemaError
  | StepProtocolError
  | ExecutionLimitError
  | IncompleteStepError
  | Tool.HandlerError<Tools[keyof Tools]>,
  | LanguageModel.LanguageModel
  | ModelRequestAccounting
  | Turn
  | Tool.HandlerServices<Tools[keyof Tools]>
  // Native generation with Tool resolution disabled may encode parameters, so the parameter codec's
  // encoding services stay a requirement.
  | Tool.ParametersEncodingServices<Tools[keyof Tools]>
  | R
> =>
  Effect.gen(function* () {
    while (true) {
      const result = yield* step(options);
      if (Predicate.isTagged(result, "Incomplete")) {
        return yield* new IncompleteStepError({ reason: result.reason });
      }
      if (result.results.length === 0) return result;
    }
  });
