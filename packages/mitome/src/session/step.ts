import { Cause, Context, Data, Effect, Exit, Fiber, Predicate, Schema, Stream } from "effect";
import type { Toolkit } from "effect/ai";
import { AiError, LanguageModel, Prompt, Response, Tool } from "effect/ai";
import type { ExecutionLimitError, SessionFencedError, SessionSaveError } from "./errors.js";
import { IncompleteStepError, StepProtocolError, ToolRegistrationError } from "./errors.js";
import { currentGeneration, ModelRequestAccounting } from "./accounting.js";
import { Approver } from "./approver.js";
import { turnControl } from "./internal.js";
import { conversationMessage, isPlainData } from "./plain.js";
import type { NotPlainMessage } from "./plain.js";
import type { TurnControl } from "./internal.js";
import { Turn } from "./turn.js";

/** The Turns whose controlled Step the current fiber is running inside, including its callbacks. */
const enteredSteps = Context.Reference<ReadonlySet<Turn["Service"]>>(
  "mitome/EnteredControlledSteps",
  { defaultValue: () => new Set() },
);

/** One local Tool Call as policy sees it, with its once-decoded parameters. */
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

const RegistrationId: unique symbol = Symbol("mitome/LocalTools");

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
 * yet authorize (provider-defined, dynamic and client-executed Tools). Duplicate names that
 * `Toolkit.make` already discarded cannot be detected.
 */
export const localTools = Effect.fnUntraced(function* <
  Tools extends Record<string, Tool.Any>,
  EX = never,
  RX = never,
>(
  toolkit: Toolkit.Toolkit<Tools>,
  build: Toolkit.HandlersFrom<Tools> | Effect.Effect<Toolkit.HandlersFrom<Tools>, EX, RX>,
): Effect.fn.Return<LocalTools<Tools>, EX | ToolRegistrationError, RX> {
  const ids = new Set<string>();
  for (const [key, tool] of Object.entries(toolkit.tools)) {
    if (key !== tool.name || ids.has(tool.id)) {
      return yield* new ToolRegistrationError({ detail: `Ambiguous Tool binding "${key}"` });
    }
    if (Tool.isProviderDefined(tool) || Tool.isDynamic(tool) || Tool.isClientExecuted(tool)) {
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
    // No prototype, so a Tool named `__proto__` gets an own gated binding, not a prototype swap.
    const output = Object.create(null) as GatedHandlers<Tools>;
    // SAFETY: the own keys of `handlers` were just checked to be exactly the Toolkit's Tool names.
    for (const name of Object.keys(handlers) as Array<keyof Toolkit.HandlersFrom<Tools>>) {
      const handler = handlers[name];
      output[name] = (params, handlerContext) => {
        // `params` is the value native handling decoded for this handler's own Tool. Frozen before
        // any callback sees it, so the handler runs with exactly the arguments that were checked.
        freezePlainData(params);
        return Effect.flatMap(
          gate(Object.freeze({ toolCallId: handlerContext.toolCallId ?? "", name, params })),
          // Only the gate asks the Host's Approver; Tool code never can (ADR-0059).
          () => handler(params, handlerContext).pipe(Effect.provideService(Approver, undefined)),
        );
      };
    }
    // SAFETY: a fully populated mutable copy of the same mapped handler type.
    return output as Toolkit.HandlersFrom<Tools>;
  };
  const registered: LocalTools<Tools> = { toolkit, [RegistrationId]: { gated, context } };
  Object.defineProperty(registered, RegistrationId, { enumerable: false });
  return registered;
});

/**
 * Freezes arrays and plain objects (prototype `Object.prototype` or `null`) in place, all the way
 * down. Other values (Dates, Maps, class instances) are left as they are.
 */
const freezePlainData = <A>(value: A): void => {
  const seen = new Set<object>();
  // A work list rather than recursion, so nesting as deep as `Schema.Json` accepts is frozen too.
  const pending: Array<unknown> = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (!Predicate.isObjectOrArray(next) || seen.has(next)) {
      continue;
    }
    const prototype: unknown = Object.getPrototypeOf(next);
    if (!Array.isArray(next) && prototype !== Object.prototype && prototype !== null) {
      continue;
    }
    seen.add(next);
    Object.freeze(next);
    for (const key of Reflect.ownKeys(next)) {
      pending.push(Object.getOwnPropertyDescriptor(next, key)?.value);
    }
  }
};

/** An author decision for one Tool Call. `ask` requires an Approval; nobody present denies. */
export type ToolDecision = "allow" | "ask" | "deny";

/** Options for one controlled Step. `R` is what its policy and restrictions need. */
export interface StepOptions<Tools extends Record<string, Tool.Any>, R = never> {
  /** The Tools exposed to the Model; only these calls are dispatched locally. */
  readonly tools?: LocalTools<Tools>;
  /** Static Instructions prepended to this Step's Model Context as a system Message; never staged. */
  readonly instructions?: string;
  /** Native Tool-choice intent. It is not authority and does not replace output validation. */
  readonly toolChoice?: LanguageModel.GenerateTextOptions<Tools>["toolChoice"];
  /**
   * Decides each call once, after its parameters are decoded. Without it a Tool's own
   * `needsApproval` asks. A failure or defect denies. Plain objects and arrays in the parameters
   * are deeply frozen, so the handler receives exactly the arguments policy decided on: a write to
   * them is ignored, or denies the call if it throws out of the callback. Other values, such as a
   * decoded `Date`, a `Map` or a class instance, are not frozen, and mutating one changes what the
   * handler receives. The Approver is shown the JSON the Model sent, without fields the Tool does
   * not declare, not this decoded value.
   */
  readonly policy?: (call: ToolCallRequest<Tools>) => Effect.Effect<ToolDecision, unknown, R>;
  /**
   * Each sees every call after `policy` (or the Tool's own flag) and can only tighten its decision:
   * the strictest wins, deny over ask over allow. A failure or defect denies. They see the
   * parameters frozen exactly as `policy` does, with the same limits, and no Approver.
   */
  readonly restrictions?: ReadonlyArray<
    (call: ToolCallRequest<Tools>) => Effect.Effect<ToolDecision, unknown, R>
  >;
}

/**
 * A local Tool result of a controlled Step: the native result part, whose failure may also be the
 * gate's denial, an `AiError` given to every Tool whatever its failure mode.
 */
export type StepToolResult<Tools extends Record<string, Tool.Any>> = {
  readonly [Name in keyof Tools]: Name extends string
    ? Response.ToolResultPart<
        Name,
        Tool.Success<Tools[Name]>,
        Tool.FailureResult<Tools[Name]> | AiError.AiError
      >
    : never;
}[keyof Tools];

type StepResultCases<Tools extends Record<string, Tool.Any>> = Data.TaggedEnum<{
  /**
   * The Model response is complete. `response` is the original native response; `results` are
   * this Step's separately resolved local Tool results, which the response's own getters do not
   * include. Its conversation contribution has been committed, with whatever was staged before it,
   * as one Entry; a response that contributes nothing, with nothing staged before it, commits none.
   */
  Complete: {
    readonly response: LanguageModel.GenerateTextResponse<Tools, "encoded">;
    readonly results: ReadonlyArray<StepToolResult<Tools>>;
  };
  /**
   * The Model response explicitly reports it is incomplete. No local Tool ran and nothing was
   * staged; the program decides what to do next.
   */
  Incomplete: {
    readonly response: LanguageModel.GenerateTextResponse<Tools, "encoded">;
    readonly reason: Response.FinishReason;
  };
}>;

export type CompleteStep<Tools extends Record<string, Tool.Any>> = Extract<
  StepResult<Tools>,
  { readonly _tag: "Complete" }
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
    module: "mitome",
    method: "step",
    reason: new AiError.UnknownError({ description }),
  });

// A Tool's failure codec can encode a denial without its reason, so a denial is encoded as the
// `AiError` it is whatever the Tool's failure mode or schema (ADR-0019, ADR-0059).
const encodeDenial = Schema.encodeEffect(Schema.toCodecJson(AiError.AiError));

/** Where a Message of the conversation stops being plain data, said for an error's detail. */
const described = (role: string, issue: NotPlainMessage) =>
  `its ${role} Message has ${issue.found} at ${issue.path}, not plain data`;

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
  readonly calls: ReadonlyArray<LocalCall>;
  /** The response as the conversation keeps it: checked, and detached from the Provider's objects. */
  readonly messages: ReadonlyArray<Prompt.Message>;
}

/**
 * One local Tool Call as dispatch uses it. `params` is the value in the checked copy of the
 * response, so the Approver, the Tool's decoder and the conversation all get the same value, and a
 * later change to the Provider's own object reaches none of them.
 */
interface LocalCall {
  readonly id: string;
  readonly name: string;
  readonly params: Schema.Json;
}

/**
 * Validates the whole response before anything local runs; never trusts the first-finish getter.
 * Contradictory data is malformed even in an incomplete response, and so is a response whose
 * contribution to the conversation is not plain data (Tool Call parameters a binding let through
 * as live values, say): it is refused here, typed, rather than die when staged after its Tools
 * ran. Only local Tools are exposed
 * (native decoding rejects calls to any other name), so a Provider-executed call or a Tool result
 * inside the response can only be contradictory: remote capabilities need their own pre-request
 * grants, which controlled Steps do not yet support.
 */
const classify = Effect.fnUntraced(function* (
  content: ReadonlyArray<Response.AnyPart>,
): Effect.fn.Return<Classified, StepProtocolError> {
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
    if (part.type !== "tool-call") {
      continue;
    }
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
    // oxlint-disable-next-line typescript/no-unsafe-argument -- Effect types a response's Tool Call name and parameters as `any`
    calls.push(part);
  }
  const messages: Array<Prompt.Message> = [];
  const checked = new Map<string, Schema.Json>();
  for (const message of Prompt.fromResponseParts(content).content) {
    const kept = yield* conversationMessage(message).pipe(
      Effect.catchTags({
        NotPlainMessage: (issue) =>
          Effect.fail(protocol("malformed-response", `Response ${described(message.role, issue)}`)),
        SchemaError: (error) =>
          Effect.fail(protocol("malformed-response", `Response does not encode: ${error.message}`)),
      }),
    );
    messages.push(kept);
    if (kept.role !== "assistant") {
      continue;
    }
    for (const part of kept.content) {
      if (part.type === "tool-call" && isPlainData(part.params)) {
        checked.set(part.id, part.params);
      }
    }
  }
  const finish = finishes[0];
  if (finish?.reason === "pause") {
    return yield* protocol("unsupported-continuation", "Provider paused the response");
  }
  if (finish !== undefined && finish.reason !== "stop" && finish.reason !== "tool-calls") {
    return { incomplete: finish.reason, calls: [], messages };
  }
  if (finish?.reason === "tool-calls" && calls.length === 0) {
    return yield* protocol("malformed-response", "Finish reports Tool Calls but has none");
  }
  const local: Array<LocalCall> = [];
  for (const { id, name } of calls) {
    const params = checked.get(id);
    if (params === undefined) {
      return yield* protocol("malformed-response", `Tool Call "${id}" has no plain parameters`);
    }
    local.push({ id, name, params });
  }
  return { incomplete: undefined, calls: local, messages };
});

/** Runs `operation` on its own child fiber and waits for it, including when interrupted. */
const owned = <A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const child = yield* Effect.forkChild(restore(operation));
      return yield* restore(Fiber.join(child)).pipe(Effect.ensuring(Fiber.interrupt(child)));
    }),
  );

/** Whether a Tool's own risk flag asks for an Approval; a failing predicate denies. */
const toolDefault = <Tools extends Record<string, Tool.Any>>(
  tool: Tool.Any,
  request: ToolCallRequest<Tools>,
  prompt: Prompt.Prompt,
): Effect.Effect<ToolDecision, unknown> => {
  const needsApproval = tool.needsApproval;
  if (needsApproval === undefined || needsApproval === false) {
    return Effect.succeed("allow");
  }
  if (needsApproval === true) {
    return Effect.succeed("ask");
  }
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

const dispatch = Effect.fnUntraced(function* <Tools extends Record<string, Tool.Any>, R>(
  registered: LocalTools<Tools>,
  options: StepOptions<Tools, R>,
  control: TurnControl,
  turnId: string,
  prompt: Prompt.Prompt,
  call: LocalCall,
) {
  const { gated, context } = registered[RegistrationId];
  const tools: Record<string, Tool.Any> = registered.toolkit.tools;
  // Policy, restrictions and the Approver run inside the handler with exactly the Step caller's
  // services, never the registration's.
  const services = yield* Effect.context<R>();
  const withServices = <A, E>(effect: Effect.Effect<A, E, R>) =>
    Effect.setContext(effect, services);
  // Restrictions are Extension code: only the gate asks the Host's Approver (ADR-0059).
  const restrictionServices = Context.add(services, Approver, undefined);
  let refused: ExecutionLimitError | undefined;
  let denied: AiError.AiError | undefined;
  const gate: Gate<Tools> = (request) =>
    Effect.gen(function* () {
      // The only permitted entry is this Step's call, with the value native handling decoded.
      if (request.name !== call.name || request.toolCallId !== call.id) {
        return yield* denial("Tool call is not the one this Step dispatched");
      }
      const tool = tools[call.name];
      if (tool === undefined) {
        return yield* denial("Tool call is not the one this Step dispatched");
      }
      const { policy, restrictions = [] } = options;
      let decision = yield* orDeny(
        policy === undefined
          ? // A Tool's own risk check is Tool code: only the gate asks the Host's Approver.
            toolDefault(tool, request, prompt).pipe(Effect.provideService(Approver, undefined))
          : withServices(Effect.suspend(() => policy(request))),
        "deny",
      );
      for (const restriction of restrictions) {
        const restricted = yield* orDeny(
          Effect.setContext(
            Effect.suspend(() => restriction(request)),
            restrictionServices,
          ),
          "deny",
        );
        // Only a stricter result replaces the decision; one outside the declared results is
        // strictest, so it denies below.
        if (decision === "allow" || (decision === "ask" && restricted !== "allow")) {
          decision = restricted;
        }
      }
      // Fail closed on anything outside the declared results, e.g. from untyped callers.
      if (decision !== "allow" && decision !== "ask") {
        return yield* denial("Tool call was denied by policy");
      }
      if (decision === "ask") {
        const approver = Context.get(services, Approver);
        if (approver === undefined) {
          return yield* denial("Tool call needs approval and nobody is present to give it");
        }
        const answer = yield* orDeny(
          Effect.setContext(
            Effect.suspend(() =>
              approver.decide({
                turnId,
                toolCallId: call.id,
                name: call.name,
                params: call.params,
              }),
            ),
            services,
          ),
          "deny",
        );
        if (answer !== "allow") {
          return yield* denial("Tool call was not approved");
        }
      }
      yield* control.reserve("dispatches").pipe(
        Effect.catchTag("ExecutionLimitError", (error) => {
          refused = error;
          return Effect.fail(denial("Turn reached its local Tool dispatch limit"));
        }),
      );
    }).pipe(Effect.tapError((error) => Effect.sync(() => void (denied = error))));
  const exit = yield* Effect.exit(
    owned(
      Effect.gen(function* () {
        // Frozen before `handle` decodes it, so the JSON the Approver is shown is what was decoded.
        freezePlainData(call.params);
        const handlerContext = yield* registered.toolkit
          .toHandlers(gated(gate))
          .pipe(Effect.provideContext(context));
        const ready = yield* registered.toolkit.pipe(Effect.provideContext(handlerContext));
        // Consume the whole result Stream so handler work and cleanup settle here.
        const stream = yield* ready.handle(call.name, call.params, call.id);
        const final = yield* Stream.runFold(
          stream,
          (): Stream.Success<typeof stream> | undefined => undefined,
          (latest, output) => (output.preliminary ? latest : output),
        );
        if (final === undefined) {
          return yield* Effect.die(new Error("Tool produced no result"));
        }
        return Response.makePart("tool-result", {
          id: call.id,
          name: call.name,
          result: final.result,
          encodedResult:
            denied !== undefined && final.isFailure && final.result === denied
              ? yield* encodeDenial(denied)
              : final.encodedResult,
          // What the Model is sent in place of the encoded result, as native resolution carries it.
          ...(final.modelOutput === undefined ? undefined : { modelOutput: final.modelOutput }),
          isFailure: final.isFailure,
          providerExecuted: false,
          preliminary: false,
        });
      }),
    ),
  );
  if (refused !== undefined) {
    return yield* refused;
  }
  // The Model is told of every denial: an error-mode Tool gets the failed result a return-mode
  // Tool gets. The failure mode still governs the handler's own failures. Only a Cause that is
  // exactly the denial is converted; anything else, e.g. a later defect, propagates.
  const [reason, ...others] = Exit.isFailure(exit) ? exit.cause.reasons : [];
  const result =
    denied !== undefined &&
    reason !== undefined &&
    others.length === 0 &&
    Cause.isFailReason(reason) &&
    reason.error === denied
      ? Response.makePart("tool-result", {
          id: call.id,
          name: call.name,
          result: denied,
          encodedResult: yield* encodeDenial(denied),
          isFailure: true,
          providerExecuted: false,
          preliminary: false,
        })
      : yield* exit;
  // SAFETY: the part pairs this registered Tool's name with its native, validated result.
  const part = result as StepToolResult<Tools>;
  // The checked copy is what the Step stages, so the conversation keeps what was checked.
  const kept: Array<Prompt.ToolMessagePart> = [];
  // The handler has run, so this is no protocol failure: a loose schema (`Schema.Unknown`) let a
  // live value reach the conversation, which only the Tool's author can fix.
  for (const message of Prompt.fromResponseParts([projected(part)]).content) {
    const checked = yield* conversationMessage(message).pipe(
      Effect.catchTag("NotPlainMessage", (issue) =>
        Effect.die(
          new Error(
            `Tool "${call.name}" returned a result whose encoded form is not plain data: ${described(message.role, issue)}; give it a schema that encodes it`,
          ),
        ),
      ),
      Effect.catchTag("SchemaError", (error) =>
        Effect.die(
          new Error(`Tool "${call.name}" returned a result that does not encode`, { cause: error }),
        ),
      ),
    );
    if (checked.role === "tool") {
      kept.push(...checked.content);
    }
  }
  return { part, kept };
});

/**
 * A result as the conversation carries it: a top-level undefined encoded result has no data form,
 * so Providers and the Transcript receive null. The Toolkit's JSON codecs already encode
 * `Schema.Void` as null, but not every codec does (`Schema.Any` keeps undefined). The returned
 * results keep their encodings.
 */
const projected = <Part extends { readonly encodedResult: unknown }>(part: Part): Part =>
  part.encodedResult === undefined ? { ...part, encodedResult: null } : part;

/**
 * Performs one controlled Step in the current Turn. Builds the Model Context from any
 * Instructions, committed history and this Turn's staged Messages, checks that the Model's
 * requests are accounted for, reserves one generation, generates without native Tool resolution
 * and validates the whole response. An explicitly incomplete response returns `Incomplete` with
 * nothing run, staged or committed. Otherwise its local Tool Calls run one at a time, each decided
 * once and dispatched only after its handler work and result Stream finish, and the response with
 * those results is staged and everything staged, if anything, is committed as one Entry. A commit
 * that fails with `SessionSaveError` fails the Step with nothing published; what it did not
 * publish stays staged. A Step of a Session fenced by an earlier commit fails with
 * `SessionFencedError` before its Model request. Native approval artifacts in the Prompt are
 * rejected before generation.
 * Provider, handler and codec failures, defects and interruption propagate unchanged; library
 * denials are native `AiError`s returned to the Model as failed Tool results, encoded with the
 * `AiError` JSON codec whatever the Tool's failure mode or schema so the Model reads the reason.
 */
export const step = <Tools extends Record<string, Tool.Any> = {}, R = never>(
  options: StepOptions<Tools, R> = {},
): Effect.Effect<
  StepResult<Tools>,
  | AiError.AiError
  | Schema.SchemaError
  | StepProtocolError
  | ExecutionLimitError
  | SessionSaveError
  | SessionFencedError
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
    // A Step's own callbacks (Model, policy, restrictions, Approver, handlers) run while
    // it holds its Turn's permit; starting another Step of that Turn from them would wait for
    // itself forever.
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
const admitted = Effect.fnUntraced(function* <Tools extends Record<string, Tool.Any>, R>(
  turn: Turn["Service"],
  control: TurnControl,
  options: StepOptions<Tools, R>,
) {
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
  const results: Array<StepToolResult<Tools>> = [];
  const resultParts: Array<Prompt.ToolMessagePart> = [];
  const registered = options.tools;
  if (registered !== undefined) {
    for (const call of classified.calls) {
      const { part, kept } = yield* dispatch(registered, options, control, turn.id, prompt, call);
      results.push(part);
      resultParts.push(...kept);
    }
  }
  yield* turn.stage(
    ...classified.messages,
    ...(resultParts.length === 0 ? [] : [Prompt.toolMessage({ content: resultParts })]),
  );
  yield* control.commit;
  return Complete({ response, results });
});

/**
 * The default loop: repeats `step` while the previous Step resolved local Tool Calls and returns
 * the final completed Step. An incomplete response fails with `IncompleteStepError`; reaching an
 * execution limit fails with that Step's `ExecutionLimitError`; a failed commit fails with that
 * Step's error. Each completed Step has committed what it staged.
 */
export const loop = <Tools extends Record<string, Tool.Any> = {}, R = never>(
  options: StepOptions<Tools, R> = {},
): Effect.Effect<
  CompleteStep<Tools>,
  | AiError.AiError
  | Schema.SchemaError
  | StepProtocolError
  | ExecutionLimitError
  | SessionSaveError
  | SessionFencedError
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
      if (result.results.length === 0) {
        return result;
      }
    }
  });
