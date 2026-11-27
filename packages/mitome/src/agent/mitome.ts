import { Context, Effect, Exit, Fiber, Layer, Predicate, Scope } from "effect";
import { LanguageModel } from "effect/ai";
import { Approver } from "../session/approver.js";
import type { CredentialDescriptor } from "../session/credential.js";
import type {
  SessionBusyError,
  SessionFencedError,
  SessionReleasedError,
  SessionSaveError,
  StepProtocolError,
  ToolRegistrationError,
  TranscriptError,
} from "../session/errors.js";
import { getProviderMetadata, parseQualifiedModelId } from "../session/internal.js";
import { model as providerModel } from "../session/provider.js";
import type {
  AnyProvider,
  ModelMetadataMap,
  Provider,
  QualifiedModelId,
} from "../session/provider.js";
import type { Session as KernelSession } from "../session/session.js";
import type { ModelRequestAccounting } from "../session/accounting.js";
import type { Turn } from "../session/turn.js";
import type { Agent, AnyAgent, TextMapping } from "./agent.js";
import type { Result } from "./command.js";
import {
  type CommandFailedError,
  type CommandNotFoundError,
  MitomeClosedError,
  ModelSelectionError,
  TextMappingError,
  type TranscriptSelectionError,
} from "./errors.js";
import type { Extension } from "./extension.js";
import { type ExtensionError, isAgent } from "./internal.js";
import { agentSession } from "./run.js";
import type { Session, SessionOptions } from "./session.js";
import { Transcripts } from "./transcripts.js";

/** The loadable Configuration protocol `Mitome.make` produces; a loader rejects any other value. */
export const protocol = "mitome/1";

/** The services a provisioned Model binding supplies to an Agent's program. */
type ModelServices = LanguageModel.LanguageModel | ModelRequestAccounting;

/**
 * Model services are available only from a non-empty Provider tuple; a widened array, or a union
 * with an empty tuple, may be empty.
 */
type ModelServicesOf<Providers extends ReadonlyArray<AnyProvider>> = [Providers] extends [
  readonly [AnyProvider, ...ReadonlyArray<AnyProvider>],
]
  ? ModelServices
  : never;

type ProvisionErrorOf<P> =
  P extends Provider<string, ReadonlyArray<string>, infer E, infer _R> ? E : never;

/** A Layer that requires nothing, whatever it provides or fails with. */
type ClosedLayer = Layer.Layer<never, unknown, never>;

/** What `provide` accepts: one Layer, or a non-empty list of independent ones. */
type Provided = ClosedLayer | readonly [ClosedLayer, ...ReadonlyArray<ClosedLayer>];

type ProvidedLayer<Provide> = Provide extends ReadonlyArray<infer L> ? L : Provide;

type LayerServices<L> = L extends Layer.Layer<infer ROut, infer _E, infer _R> ? ROut : never;

type LayerError<L> = L extends Layer.Layer<infer _ROut, infer E, infer _R> ? E : never;

/** What the Configuration's `provide` supplies. */
type ProvidedServices<Provide> = LayerServices<ProvidedLayer<Provide>>;

/**
 * What the Configuration's `provide` supplies, when `Keys`, its fields, name one. A Layer written in
 * place with a data-first Effect constructor, `Layer.succeed(tag, value)`, is typed only after the
 * constraints were first checked with `Provide` at its default: there anything counts as provided,
 * and the final check, with the Layers typed, is exact.
 */
type Supplied<Keys, Provide> = "provide" extends Keys
  ? [Provided] extends [Provide]
    ? any
    : ProvidedServices<Provide>
  : never;

/** How building the Configuration's `provide` can fail. */
type ProvidedError<Provide> = [Provided] extends [Provide]
  ? never
  : LayerError<ProvidedLayer<Provide>>;

/** Non-secret Provider facts available without acquiring anything. */
export interface ProviderDiscovery {
  readonly id: string;
  /** Catalog hints; any Provider-native Model id may still be selected. */
  readonly modelIds: ReadonlyArray<string>;
  readonly models: ModelMetadataMap;
  readonly credential: CredentialDescriptor | undefined;
}

/** How one acquisition selects its Model. */
export interface AcquireOptions {
  /** Restricts the configured Model to this Provider. */
  readonly provider?: string | undefined;
  /** An explicit Qualified Model id, provisioned instead of the configured Model. */
  readonly model?: string | undefined;
  /**
   * Runs once when shutdown begins, after admission closed and before any cancellation or release,
   * including the unwind of a failed startup. An embedding can start its own deadline here; the
   * instance still waits for all cleanup, and still releases everything if this fails. A native
   * Layer that fails while building rolls back its own resources before shutdown can begin, so that
   * rollback runs before this notification.
   */
  readonly onShutdown?: Effect.Effect<void> | undefined;
}

/** A fresh Session owned by an acquired Configuration, running its Agent. */
export interface InstanceSession<Input, A, E> extends Pick<
  KernelSession<SessionSaveError | SessionFencedError>,
  "transcript" | "history" | "position" | "tree" | "turns"
> {
  /** The Commands of the Agent's Extensions, in `use` order. */
  readonly commands: Session<Input, A, E, never>["commands"];
  /** Runs a Command as `Session.command` does; refused once shutdown has begun. */
  readonly command: (
    name: string,
    input: string,
  ) => Effect.Effect<
    Result,
    CommandNotFoundError | CommandFailedError | SessionReleasedError | MitomeClosedError
  >;
  /** Runs the Agent for `input` as one Turn of this Session, with the shared services bound. */
  readonly run: (
    input: Input,
  ) => Effect.Effect<
    A,
    | E
    | SessionBusyError
    | SessionReleasedError
    | SessionSaveError
    | SessionFencedError
    | MitomeClosedError
  >;
  /** Moves the position as `Session.moveTo` does; refused once shutdown has begun. */
  readonly moveTo: (
    position: string | undefined,
  ) => Effect.Effect<
    void,
    | SessionBusyError
    | SessionReleasedError
    | TranscriptError
    | SessionSaveError
    | SessionFencedError
    | MitomeClosedError
  >;
  /**
   * Releases this Session, draining an active Turn; shared services stay live. Every caller, and
   * instance shutdown, waits for the same drain.
   */
  readonly close: Effect.Effect<void>;
}

/**
 * A Configuration whose shared services and Model binding were acquired once. Its Sessions stay
 * live, idle or observed, until closed explicitly or by shutdown. `ES` is how building a Session's
 * Extensions can fail.
 */
export interface Instance<Input, A, E, ROut, ES = never> {
  /**
   * Allocates a fresh instance-owned Session, building its Agent's Extensions, in the conversation
   * `options` selects from the `Transcripts` the shared services provide, as `Session.make(agent,
   * options)` does.
   */
  readonly session: (
    options?: SessionOptions,
  ) => Effect.Effect<
    InstanceSession<Input, A, E>,
    MitomeClosedError | ES | TranscriptError | TranscriptSelectionError
  >;
  /**
   * Runs `effect` with the shared services bound, outside any Turn, as work the instance owns:
   * shutdown interrupts and awaits it before releasing those services.
   */
  readonly provide: <X, EX>(
    effect: Effect.Effect<X, EX, ROut>,
  ) => Effect.Effect<X, EX | MitomeClosedError>;
  /**
   * Closes admission, interrupts owned work (active Turns, provided work) together, waits for all
   * of it to finish and only then releases the Model binding and shared services. Idempotent:
   * every call waits for the same shutdown, however long cleanup takes.
   */
  readonly shutdown: Effect.Effect<void>;
}

/** What `Mitome.make` accepts. */
export interface ConfigurationOptions<Ag, Providers extends ReadonlyArray<AnyProvider>, Provide> {
  readonly agent: Ag;
  /**
   * Shared services: one Layer, or a non-empty list of independent Layers, each requiring nothing,
   * built once per acquisition and released at its shutdown.
   */
  readonly provide?: Provide;
  readonly providers?: Providers;
  /** The Model provisioned when no explicit Model is selected. */
  readonly model?: NoInfer<QualifiedModelId<Providers[number]>>;
}

/** The text mapping a Host uses for an Agent: its own, or the identity. */
type AgentText<Ag> =
  Ag extends Agent<
    infer Input,
    infer A,
    infer _E,
    infer _R,
    infer _Use,
    infer _RPolicy,
    infer EParse,
    infer RParse,
    infer ERender,
    infer RRender
  >
    ? TextMapping<Input, A, EParse, RParse, ERender, RRender>
    : never;

/** An acquired Configuration whose Sessions run an Agent. */
type AgentInstance<Ag, ROut> =
  Ag extends Agent<
    infer Input,
    infer A,
    infer E,
    infer _R,
    infer Use,
    infer _RPolicy,
    infer _EParse,
    infer _RParse,
    infer _ERender,
    infer _RRender
  >
    ? Instance<Input, A, E, ROut, ExtensionError<Use[number]> | ToolRegistrationError>
    : never;

/**
 * A loadable Configuration: the Agent with the Providers, Model and shared services it runs with,
 * plus inert discovery, the resolved text mapping and acquisition.
 */
export interface Configuration<
  Ag,
  Providers extends ReadonlyArray<AnyProvider>,
  Provide,
> extends ConfigurationOptions<Ag, Providers, Provide> {
  readonly protocol: typeof protocol;
  /** Provider facts read without provisioning, authenticating or acquiring anything. */
  readonly discovery: ReadonlyArray<ProviderDiscovery>;
  /**
   * The Agent's text mapping, or the identity: text in, a string result out, and any other result a
   * `TextMappingError`. A Host that loaded this Configuration uses it without the Agent's types.
   */
  readonly text: AgentText<Ag>;
  /**
   * Validates the selection, then builds the shared services and provisions the selected Model. A
   * failure at any point releases what was acquired. The enclosing Scope owns the instance;
   * closing it shuts the instance down.
   */
  readonly acquire: (
    options?: AcquireOptions,
  ) => Effect.Effect<
    AgentInstance<Ag, ProvidedServices<Provide>>,
    | ProvidedError<Provide>
    | ProvisionErrorOf<Providers[number]>
    | StepProtocolError
    | ModelSelectionError,
    Scope.Scope
  >;
}

type Candidate = { readonly provider: AnyProvider; readonly modelId: string };

/** The Model one acquisition provisions, if any. A catalog never supplies one. */
const candidate = Effect.fnUntraced(function* (
  providers: ReadonlyArray<AnyProvider>,
  configured: string | undefined,
  selection: AcquireOptions,
): Effect.fn.Return<Candidate | undefined, ModelSelectionError> {
  const fail = (detail: string) => Effect.fail(new ModelSelectionError({ detail }));
  const declared = providers.map(({ id }) => id).join(", ") || "none";
  const find = (id: string) => providers.find((provider) => provider.id === id);
  if (selection.provider !== undefined && find(selection.provider) === undefined) {
    return yield* fail(`unknown Provider "${selection.provider}" (declared: ${declared})`);
  }
  if (selection.model !== undefined) {
    const parsed = parseQualifiedModelId(selection.model);
    if (parsed === undefined) {
      return yield* fail(`"${selection.model}" is not a Qualified Model id (provider/model)`);
    }
    if (selection.provider !== undefined && parsed.providerId !== selection.provider) {
      return yield* fail(
        `Model "${selection.model}" does not belong to Provider "${selection.provider}"`,
      );
    }
    const provider = find(parsed.providerId);
    if (provider === undefined) {
      return yield* fail(`unknown Provider "${parsed.providerId}" (declared: ${declared})`);
    }
    return { provider, modelId: parsed.modelId };
  }
  if (providers.length === 0) {
    return undefined;
  }
  const parsed = configured === undefined ? undefined : parseQualifiedModelId(configured);
  const provider = parsed && find(parsed.providerId);
  if (parsed === undefined || provider === undefined) {
    return yield* fail("the Configuration sets no Model; select a Qualified Model id");
  }
  if ((selection.provider ?? provider.id) !== provider.id) {
    return yield* fail(
      `the Configuration sets no Model of Provider "${selection.provider}"; select a Qualified Model id`,
    );
  }
  return { provider, modelId: parsed.modelId };
});

/** The Configuration as `acquire` uses it, after `Mitome.make` checked its types. */
interface ErasedOptions {
  readonly agent: AnyAgent;
  readonly provide?: Provided;
  readonly providers?: ReadonlyArray<AnyProvider>;
  readonly model?: string;
}

type ErasedInstance = Instance<unknown, unknown, unknown, unknown, unknown>;

/**
 * Runs `effect` once, on its own fiber, and lets every caller await that run: interrupting a caller
 * neither cancels nor restarts it (`Effect.cached` alone restarts work its callers abandoned).
 * Obtaining the handle, after `before` in the same step, is uninterruptible, so a caller cannot
 * leave between the fork and its publication and let a later caller fork the work again, nor after
 * `before` without launching the work; only the wait is interruptible.
 */
const once = <A, E>(effect: Effect.Effect<A, E>, before: Effect.Effect<void> = Effect.void) =>
  Effect.map(Effect.cached(Effect.forkDetach(effect)), (run) =>
    Effect.flatMap(Effect.uninterruptible(Effect.andThen(before, run)), Fiber.join),
  );

const acquire = Effect.fnUntraced(function* (options: ErasedOptions, selection: AcquireOptions) {
  const selected = yield* candidate(options.providers ?? [], options.model, selection);
  let admitting = true;
  // A failed startup closes with its failure, so exit-aware releases can roll back.
  let closing: Exit.Exit<unknown, unknown> = Exit.void;
  // The shared services are built into `resources` first, so they are released last.
  const { resources, shutdown } = yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const resources = yield* Scope.make();
      // Admission closes in the caller, in the step that launches the shared work.
      const shutdown = yield* once(
        // A failing or interrupted notification must not skip releasing what is owned.
        Effect.ensuring(
          selection.onShutdown ?? Effect.void,
          Effect.suspend(() => Scope.close(resources, closing)),
        ),
        Effect.sync(() => void (admitting = false)),
      );
      return { resources, shutdown };
    }),
    ({ shutdown }) => shutdown,
  );
  const admit = Effect.suspend(() =>
    admitting ? Effect.void : Effect.fail(new MitomeClosedError()),
  );

  return yield* Effect.gen(function* () {
    const [first, ...rest] = [options.provide ?? []].flat();
    // SAFETY: what the Configuration provides, and nothing without `provide`: `Mitome.make` already
    // checked that whatever runs with these services requires nothing else of them.
    const provided = (
      first === undefined ? Layer.empty : Layer.mergeAll(first, ...rest)
    ) as Layer.Layer<unknown, unknown>;
    const layer = yield* Layer.buildWithScope(provided, resources);
    const model =
      selected === undefined
        ? Context.empty()
        : yield* Layer.buildWithScope(
            providerModel(selected.provider, selected.modelId),
            resources,
          ).pipe(Effect.provideContext(layer));
    // Never bind the acquisition Scope: each Turn must keep the Scope its Session supplies. Nor an
    // Approver: whoever runs the Turn supplies it.
    const services = Context.omit(Scope.Scope, Approver)(Context.merge(layer, model));
    // Only the Configuration decides where its conversations are kept: without a store of its own
    // its Sessions stay in memory, whatever the caller of `session` provides.
    const transcripts = Context.get(services, Transcripts);
    // The layer may supply the Model itself, so only what was built can tell the default program
    // has none; failing here releases it before any Turn.
    if (
      options.agent.program === undefined &&
      Context.getOrUndefined(services, LanguageModel.LanguageModel) === undefined
    ) {
      return yield* new ModelSelectionError({
        detail: "the Configuration provides no Model, and the Agent's default program needs one",
      });
    }
    // Owned work closes in parallel, so one stuck Turn does not delay cancelling the rest.
    const work = yield* Scope.fork(resources, "parallel");

    const instance: ErasedInstance = {
      session: (selection) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* admit;
            // Closing a forked Scope detaches it from its parent before its finalizers finish, so
            // the Session's Scope stays unattached and `work` holds a finalizer awaiting the one
            // shared close until it completes: shutdown then still drains a Session being closed.
            const scope = yield* Scope.make();
            const holder = yield* Scope.fork(work);
            const drain = yield* once(Scope.close(scope, Exit.void));
            yield* Scope.addFinalizer(holder, drain);
            // Releasing the holder is part of the shared work, so a caller that leaves cannot skip it.
            const close = yield* once(Effect.andThen(drain, Scope.close(holder, Exit.void)));
            // Construction runs Extension code, so it is work the instance owns: shutdown and the
            // caller can cancel it, and shutdown awaits it before releasing the shared services.
            // Forked into `holder` after `drain`, so it is cancelled before its Scope drains.
            const fiber = yield* Effect.forkIn(
              agentSession(options.agent, selection).pipe(
                Effect.provideService(Transcripts, transcripts),
                Effect.provideContext(services),
                Scope.provide(scope),
              ),
              holder,
            );
            const session = yield* restore(Fiber.join(fiber)).pipe(
              Effect.ensuring(Fiber.interrupt(fiber)),
              Effect.onError(() => close),
            );
            return {
              run: (input) =>
                Effect.andThen(admit, session.run(input).pipe(Effect.provideContext(services))),
              transcript: session.transcript,
              history: session.history,
              position: session.position,
              moveTo: (position) => Effect.andThen(admit, session.moveTo(position)),
              tree: session.tree,
              turns: session.turns,
              commands: session.commands,
              command: (name, input) => Effect.andThen(admit, session.command(name, input)),
              close,
            };
          }),
        ),
      provide: (effect) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* admit;
            const fiber = yield* Effect.forkIn(effect.pipe(Effect.provideContext(services)), work);
            return yield* restore(Fiber.join(fiber)).pipe(Effect.ensuring(Fiber.interrupt(fiber)));
          }),
        ),
      shutdown,
    };
    return instance;
  }).pipe(
    Effect.onError((cause) =>
      Effect.suspend(() => {
        closing = Exit.failCause(cause);
        return shutdown;
      }),
    ),
  );
});

const identityText: TextMapping<string, unknown, never, never, TextMappingError> = {
  parse: Effect.succeed,
  render: (result) =>
    Predicate.isString(result)
      ? Effect.succeed(result)
      : Effect.fail(
          new TextMappingError({
            detail: "the Agent's result is not a string; give the Agent a text mapping",
          }),
        ),
};

/**
 * Names an Agent with the Providers, Model and shared services it runs with. Every requirement
 * must close here: the Agent's program may need only the provided services, its `Turn` and Turn
 * `Scope`, and (with a non-empty Provider tuple) the selected Model; the Extensions' setups,
 * policies and Commands may need only the provided services and the Model; Providers and the text
 * mapping may need only the provided services. The result keeps the fields as given and
 * adds inert `discovery`, the resolved `text` mapping and an `acquire` that needs nothing but its
 * owning Scope. Nothing is acquired, provisioned or authenticated here. Throws on an Agent not
 * made by `Agent.make`, duplicate Provider ids, a configured Model that names no declared
 * Provider, and Providers created by another copy of the package.
 */
export const make = <
  Ag,
  Keys extends keyof ConfigurationOptions<never, readonly [], never>,
  Input,
  A,
  E,
  R extends Supplied<Keys, Provide> | Turn | Scope.Scope | ModelServicesOf<Providers>,
  Use extends ReadonlyArray<
    Extension<any, unknown, Supplied<Keys, Provide> | ModelServicesOf<Providers>>
  >,
  RPolicy,
  EParse,
  RParse extends Supplied<Keys, Provide>,
  ERender,
  RRender extends Supplied<Keys, Provide>,
  const Providers extends ReadonlyArray<
    Provider<string, ReadonlyArray<string>, unknown, Supplied<Keys, Provide>>
  > = readonly [],
  // The constraint, not `never`: a default is what a Layer built in the list is first typed
  // against, and a narrower one would type it instead of its own arguments.
  const Provide extends Provided = Provided,
>(
  options: ConfigurationOptions<Ag, Providers, Provide> & {
    readonly agent: Agent<Input, A, E, R, Use, RPolicy, EParse, RParse, ERender, RRender>;
  } & {
    // Written, `provide` holds a Layer or a list, never `undefined`: whether it was written is
    // what decides it provides anything.
    readonly [Key in Keys]-?: Key extends "provide" ? NonNullable<unknown> : unknown;
  },
): Configuration<Ag, Providers, Provide> => {
  // Each field read once, inherited ones included, and the Provider and Layer lists copied, so
  // validation, discovery, the result and acquisition all see the same values.
  const { agent, provide, providers: given, model } = options;
  if (!isAgent(agent)) {
    throw new TypeError("Mitome.make expects an Agent made by Agent.make");
  }
  const fields = {
    agent,
    ...(provide === undefined
      ? undefined
      : // SAFETY: a frozen copy of the same Layers, in the same order.
        { provide: Array.isArray(provide) ? (Object.freeze([...provide]) as Provide) : provide }),
    // SAFETY: a frozen copy of the same Providers, in the same order.
    ...(given === undefined ? undefined : { providers: Object.freeze([...given]) as Providers }),
    ...(model === undefined ? undefined : { model }),
  };
  const providers: ReadonlyArray<AnyProvider> = fields.providers ?? [];
  const ids = new Set<string>();
  const discovery = providers.map((provider) => {
    const metadata = getProviderMetadata(provider);
    if (metadata === undefined) {
      throw new TypeError("Provider was not created by this copy of the package");
    }
    if (ids.has(provider.id)) {
      throw new TypeError(`Duplicate Provider id "${provider.id}"`);
    }
    ids.add(provider.id);
    return {
      id: provider.id,
      modelIds: provider.modelIds,
      models: metadata.models,
      credential: metadata.credential,
    };
  });
  if (model !== undefined) {
    const parsed = parseQualifiedModelId(model);
    if (parsed === undefined || !ids.has(parsed.providerId)) {
      throw new TypeError(`Configured Model "${model}" names no declared Provider`);
    }
  }
  // SAFETY: the type parameters' constraints are the closure this cast relies on. The program's
  // requirements are the provided services, Turn, Scope and (only with a non-empty Provider tuple)
  // the Model services `acquire` provides; the Extensions' requirements are the provided services
  // and the Model; Provider and text requirements are the provided services; what is provided
  // needs nothing.
  const erased = fields as ErasedOptions;
  const mapping: TextMapping<
    Input | string,
    A,
    EParse,
    RParse,
    ERender | TextMappingError,
    RRender
  > = agent.text ?? identityText;
  // The mapping is Agent code, so a Host running it with the shared services never hands it the
  // Configuration's conversations.
  const text = {
    // Suspended, so the mask also covers what a callback does before it returns its Effect.
    parse: (value: string) =>
      Effect.suspend(() => mapping.parse(value)).pipe(
        Effect.provideService(Transcripts, undefined),
      ),
    render: (result: A) =>
      Effect.suspend(() => mapping.render(result)).pipe(
        Effect.provideService(Transcripts, undefined),
      ),
  };
  return {
    ...fields,
    protocol,
    discovery,
    // SAFETY: the Agent's own mapping, or without one the identity (its program accepts any string
    // and returns a string, as `Agent.make` requires, and its renderer's error is
    // `TextMappingError`), each callback run unchanged apart from a withheld reference.
    text: text as AgentText<Ag>,
    // SAFETY: `acquire` runs the same Configuration, so its values have exactly these types.
    acquire: (selection = {}) =>
      acquire(erased, selection) as Effect.Effect<
        AgentInstance<Ag, ProvidedServices<Provide>>,
        | ProvidedError<Provide>
        | ProvisionErrorOf<Providers[number]>
        | StepProtocolError
        | ModelSelectionError,
        Scope.Scope
      >,
  };
};
