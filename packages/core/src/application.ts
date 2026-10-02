import { Cause, Context, Effect, Exit, Fiber, Layer, Result, Schema, Scope } from "effect";
import type { LanguageModel } from "effect/ai";
import type { CredentialDescriptor } from "./credential.js";
import { getProviderMetadata, parseQualifiedModelId, providerModel } from "./provider.js";
import type { AnyProvider, ModelMetadataMap, Provider, QualifiedModelId } from "./provider.js";
import type {
  SessionBusyError,
  SessionReleasedError,
  StepProtocolError,
} from "./session/errors.js";
// makeSession allocates a public Session in a supplied Scope; it is not a Layer-owned service.
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports
import { makeSession } from "./session/session.js";
import type { ExecutionLimits, Session, Turn } from "./session/session.js";
import type { ModelRequestAccounting } from "./session/step.js";

/** The loadable application protocol `defineMitome` produces; a loader rejects any other value. */
export const mitomeProtocol = "mitome/1";

/** Work offered to an application after its shutdown started. */
export class ApplicationClosedError extends Schema.TaggedError<ApplicationClosedError>()(
  "ApplicationClosedError",
  {},
) {
  /** Fixed description; the error carries no fields. */
  override get message(): string {
    return "Application is shutting down and admits no new work";
  }
}

/** No Model could be selected or provisioned for an application's acquisition. */
export class ModelSelectionError extends Schema.TaggedError<ModelSelectionError>()(
  "ModelSelectionError",
  { detail: Schema.String },
) {
  /** Description derived from `detail`. */
  override get message(): string {
    return `Model selection failed: ${this.detail}`;
  }
}

/** The services a provisioned Model binding supplies to an application's program. */
type ModelServices = LanguageModel.LanguageModel | ModelRequestAccounting;

/** Model services are available to the program only when the application declares Providers. */
type ModelServicesOf<Providers extends ReadonlyArray<AnyProvider>> = Providers extends readonly []
  ? never
  : ModelServices;

type ProvisionErrorOf<P> =
  P extends Provider<string, ReadonlyArray<string>, infer E, infer _R> ? E : never;

/** Non-secret Provider facts available without acquiring anything. */
export interface ProviderDiscovery {
  readonly id: string;
  /** Catalog hints; any Provider-native Model id may still be selected. */
  readonly modelIds: ReadonlyArray<string>;
  readonly models: ModelMetadataMap;
  readonly credential: CredentialDescriptor | undefined;
}

/** How one acquisition selects its Model and whether it starts the declared serving Hosts. */
export interface AcquireOptions {
  /** Restricts the configured default and fallbacks to this Provider. */
  readonly provider?: string | undefined;
  /** An explicit Qualified Model id. It is provisioned alone and never falls back. */
  readonly model?: string | undefined;
  /** Starts every declared serving Host before the application is ready. */
  readonly serve?: boolean | undefined;
  /**
   * Runs once when shutdown begins, after admission closed and before any cancellation or release,
   * including the unwind of a failed startup. An embedding can start its own deadline here; the
   * application still waits for all cleanup, and still releases everything if this fails. A native
   * Layer that fails while building rolls back its own resources before shutdown can begin, so that
   * rollback runs before this notification.
   */
  readonly onShutdown?: Effect.Effect<void> | undefined;
}

/** A fresh Session owned by an acquired application, running the application's program. */
export interface ApplicationSession<Input, A, E> extends Pick<
  Session,
  "history" | "turns" | "observe"
> {
  /** Runs the program for `input` as one Turn of this Session, with the shared services bound. */
  readonly run: (
    input: Input,
  ) => Effect.Effect<A, E | SessionBusyError | SessionReleasedError | ApplicationClosedError>;
  /**
   * Releases this Session, draining an active Turn; shared infrastructure stays live. Every
   * caller, and application shutdown, waits for the same drain.
   */
  readonly close: Effect.Effect<void>;
}

/**
 * An application whose infrastructure and Model binding were acquired once. Its Sessions stay
 * live, idle or observed, until closed explicitly or by shutdown.
 */
export interface Application<Input, A, E, ROut> {
  /** Allocates a fresh application-owned Session. */
  readonly session: Effect.Effect<ApplicationSession<Input, A, E>, ApplicationClosedError>;
  /**
   * Runs `effect` with the shared infrastructure bound, outside any Turn, as work the application
   * owns: shutdown interrupts and awaits it before releasing that infrastructure.
   */
  readonly provide: <X, EX>(
    effect: Effect.Effect<X, EX, ROut>,
  ) => Effect.Effect<X, EX | ApplicationClosedError>;
  /**
   * Closes admission, interrupts owned work (serving Hosts, active Turns, provided work) together,
   * waits for all of it to finish and only then releases the Model binding and infrastructure.
   * Idempotent: every call waits for the same shutdown, however long cleanup takes.
   */
  readonly shutdown: Effect.Effect<void>;
}

/**
 * A process-local serving Host. `start` acquires the Host's resources in its own Scope and returns
 * its long-lived serving Effect; readiness waits for every `start`. A serving failure is logged
 * with the Host's name and is not restarted; other Hosts and Sessions stay live.
 */
export interface MitomeHost<Input, A, E, ROut, ES> {
  readonly name: string;
  readonly start: (
    application: Application<Input, A, E, ROut>,
  ) => Effect.Effect<
    Effect.Effect<typeof Schema.Unknown.Type, typeof Schema.Unknown.Type, ROut>,
    ES,
    ROut | Scope.Scope
  >;
}

/** Explicit mapping between CLI text and the program's own input and result. */
export interface MitomeCli<Input, A, EP, RP, ER, RR> {
  readonly parseInput: (text: string) => Effect.Effect<Input, EP, RP>;
  readonly renderResult: (result: A) => Effect.Effect<string, ER, RR>;
}

/** The declarative composition `defineMitome` accepts. */
export interface MitomeOptions<
  Input,
  A,
  E,
  R,
  Providers extends ReadonlyArray<AnyProvider>,
  ROut,
  EI,
  EP,
  RP,
  ER,
  RR,
  ES,
> {
  /** The ordinary program, run as one whole-function Turn per request. */
  readonly program: (input: Input) => Effect.Effect<A, E, R>;
  /** Bounds applied to each Turn of the application's Sessions. */
  readonly limits: ExecutionLimits;
  /** Shared infrastructure, built once per acquisition and released at its shutdown. */
  readonly infrastructure?: Layer.Layer<ROut, EI>;
  readonly providers?: Providers;
  /** The Model provisioned when no explicit Model is selected. */
  readonly defaultModel?: NoInfer<QualifiedModelId<Providers[number]>>;
  /** Tried in order, only after the configured Models before them fail to provision. */
  readonly fallbackModels?: ReadonlyArray<NoInfer<QualifiedModelId<Providers[number]>>>;
  /**
   * Where Auth capabilities store Credentials; defaults to Core's `configDirectory()`. Pass the
   * same directory to any Provider factory that reads them, such as `codex({ configDirectory })`.
   */
  readonly configDirectory?: string | undefined;
  readonly cli?: MitomeCli<NoInfer<Input>, NoInfer<A>, EP, RP, ER, RR>;
  readonly hosts?: ReadonlyArray<
    MitomeHost<NoInfer<Input>, NoInfer<A>, NoInfer<E>, NoInfer<ROut>, ES>
  >;
}

/** A loadable application: the original composition plus inert discovery and acquisition. */
export interface Mitome<
  Input,
  A,
  E,
  R,
  Providers extends ReadonlyArray<AnyProvider>,
  ROut,
  EI,
  EP,
  RP,
  ER,
  RR,
  ES,
> extends MitomeOptions<Input, A, E, R, Providers, ROut, EI, EP, RP, ER, RR, ES> {
  readonly protocol: typeof mitomeProtocol;
  /** Provider facts read without provisioning, authenticating or acquiring anything. */
  readonly discovery: ReadonlyArray<ProviderDiscovery>;
  /**
   * Validates the selection, then builds the infrastructure, provisions the selected Model and,
   * when asked, starts the serving Hosts. A failure at any point releases what was acquired. The
   * enclosing Scope owns the application; closing it shuts the application down.
   */
  readonly acquire: (
    options?: AcquireOptions,
  ) => Effect.Effect<
    Application<Input, A, E, ROut>,
    EI | ProvisionErrorOf<Providers[number]> | StepProtocolError | ModelSelectionError | ES,
    Scope.Scope
  >;
}

type Candidate = { readonly provider: AnyProvider; readonly modelId: string };

const describe = (cause: typeof Schema.Unknown.Type): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * The Models one acquisition may provision, in order. Explicit selection is a single candidate; a
 * catalog never supplies one.
 */
const candidates = (
  providers: ReadonlyArray<AnyProvider>,
  configured: ReadonlyArray<string>,
  selection: AcquireOptions,
): Effect.Effect<ReadonlyArray<Candidate>, ModelSelectionError> =>
  Effect.gen(function* () {
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
      return [{ provider, modelId: parsed.modelId }];
    }
    if (providers.length === 0) return [];
    const chain = configured.flatMap((id) => {
      const parsed = parseQualifiedModelId(id);
      const provider = parsed && find(parsed.providerId);
      return parsed && provider && (selection.provider ?? provider.id) === provider.id
        ? [{ provider, modelId: parsed.modelId }]
        : [];
    });
    if (chain.length === 0) {
      return yield* fail(
        selection.provider === undefined
          ? "the application configures no default Model; select a Qualified Model id"
          : `the application configures no Model of Provider "${selection.provider}"; select a Qualified Model id`,
      );
    }
    return chain;
  });

/**
 * Provisions the first candidate that succeeds, each in its own Scope. A configured candidate's
 * typed failure is released before the next is tried; defects and interruption are not fallback.
 */
const provisionModel = (
  chain: ReadonlyArray<Candidate>,
  explicit: boolean,
  infrastructure: Context.Context<typeof Schema.Unknown.Type>,
  resources: Scope.Scope,
) =>
  Effect.gen(function* () {
    if (chain.length === 0) return Context.empty();
    const failures: Array<string> = [];
    for (const { provider, modelId } of chain) {
      const attempt = yield* Scope.fork(resources);
      const build = Layer.buildWithScope(providerModel(provider, modelId), attempt).pipe(
        Effect.provideContext(infrastructure),
      );
      if (explicit) return yield* build;
      const result = yield* Effect.result(build);
      if (Result.isSuccess(result)) return result.success;
      failures.push(`${provider.id}/${modelId}: ${describe(result.failure)}`);
      yield* Scope.close(attempt, Exit.fail(result.failure));
    }
    return yield* new ModelSelectionError({
      detail: `no configured Model could be provisioned (${failures.join("; ")})`,
    });
  });

/** The composition as `acquire` uses it, after `defineMitome` checked its types. */
interface ErasedOptions {
  readonly program: (
    input: typeof Schema.Unknown.Type,
  ) => Effect.Effect<
    typeof Schema.Unknown.Type,
    typeof Schema.Unknown.Type,
    typeof Schema.Unknown.Type
  >;
  readonly limits: ExecutionLimits;
  readonly infrastructure?: Layer.Layer<typeof Schema.Unknown.Type, typeof Schema.Unknown.Type>;
  readonly providers?: ReadonlyArray<AnyProvider>;
  readonly defaultModel?: string;
  readonly fallbackModels?: ReadonlyArray<string>;
  readonly hosts?: ReadonlyArray<
    MitomeHost<
      typeof Schema.Unknown.Type,
      typeof Schema.Unknown.Type,
      typeof Schema.Unknown.Type,
      typeof Schema.Unknown.Type,
      typeof Schema.Unknown.Type
    >
  >;
}

type ErasedApplication = Application<
  typeof Schema.Unknown.Type,
  typeof Schema.Unknown.Type,
  typeof Schema.Unknown.Type,
  typeof Schema.Unknown.Type
>;

// SAFETY: an application without infrastructure provides nothing, and `defineMitome` already
// checked that such a composition requires nothing from it.
const noInfrastructure = Layer.empty as Layer.Layer<typeof Schema.Unknown.Type>;

const acquire = (options: ErasedOptions, selection: AcquireOptions) =>
  Effect.gen(function* () {
    const providers = options.providers ?? [];
    const configured = [
      ...(options.defaultModel === undefined ? [] : [options.defaultModel]),
      ...(options.fallbackModels ?? []),
    ];
    const chain = yield* candidates(providers, configured, selection);
    let admitting = true;
    // A failed startup closes with its failure, so exit-aware releases can roll back.
    let closing: Exit.Exit<unknown, unknown> = Exit.void;
    // Infrastructure is built into `resources` first, so it is released last.
    const { resources, shutdown } = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const resources = yield* Scope.make();
        const shutdown = yield* Effect.cached(
          Effect.suspend(() => {
            admitting = false;
            // A failing or interrupted notification must not skip releasing what is owned.
            return Effect.ensuring(
              selection.onShutdown ?? Effect.void,
              Effect.suspend(() => Scope.close(resources, closing)),
            );
          }),
        );
        return { resources, shutdown };
      }),
      ({ shutdown }) => shutdown,
    );
    const admit = Effect.suspend(() =>
      admitting ? Effect.void : Effect.fail(new ApplicationClosedError()),
    );

    return yield* Effect.gen(function* () {
      const infrastructure = yield* Layer.buildWithScope(
        options.infrastructure ?? noInfrastructure,
        resources,
      );
      const model = yield* provisionModel(
        chain,
        selection.model !== undefined,
        infrastructure,
        resources,
      );
      // Never bind the acquisition Scope: each Turn must keep the Scope its Session supplies.
      const services = Context.omit(Scope.Scope)(Context.merge(infrastructure, model));
      // Owned work closes in parallel, so one stuck Turn does not delay cancelling the rest.
      const work = yield* Scope.fork(resources, "parallel");

      const application: ErasedApplication = {
        session: Effect.uninterruptible(
          Effect.gen(function* () {
            yield* admit;
            // Closing a forked Scope detaches it from its parent before its finalizers finish, so
            // the Session's Scope stays unattached and `work` holds a finalizer awaiting the one
            // shared close until it completes: shutdown then still drains a Session being closed.
            const scope = yield* Scope.make();
            const holder = yield* Scope.fork(work);
            const drain = yield* Effect.cached(Scope.close(scope, Exit.void));
            yield* Scope.addFinalizer(holder, drain);
            const session = yield* makeSession({
              persistence: "none",
              limits: options.limits,
            }).pipe(Scope.provide(scope));
            return {
              run: (input) =>
                Effect.andThen(
                  admit,
                  session.run(
                    Effect.suspend(() => options.program(input)).pipe(
                      Effect.provideContext(services),
                    ),
                  ),
                ),
              history: session.history,
              turns: session.turns,
              observe: session.observe,
              close: Effect.andThen(drain, Scope.close(holder, Exit.void)),
            };
          }),
        ),
        provide: (effect) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              yield* admit;
              const fiber = yield* Effect.forkIn(
                effect.pipe(Effect.provideContext(services)),
                work,
              );
              return yield* restore(Fiber.join(fiber)).pipe(
                Effect.ensuring(Fiber.interrupt(fiber)),
              );
            }),
          ),
        shutdown,
      };

      if (selection.serve === true) {
        for (const host of options.hosts ?? []) {
          const scope = yield* Scope.fork(work);
          const serving = yield* host
            .start(application)
            .pipe(Effect.provideContext(services), Scope.provide(scope));
          yield* Effect.forkIn(
            serving.pipe(
              Effect.provideContext(services),
              Effect.tapCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.logError(`Serving Host "${host.name}" failed`, cause),
              ),
            ),
            scope,
          );
        }
      }
      return application;
    }).pipe(
      Effect.onError((cause) =>
        Effect.suspend(() => {
          closing = Exit.failCause(cause);
          return shutdown;
        }),
      ),
    );
  });

/**
 * Declares a loadable application around an ordinary program. Every requirement must close here:
 * the program may need only the infrastructure's services, its `Turn` and Turn `Scope`, and (with
 * Providers) the selected Model; Providers, CLI mappings and Hosts may need only the
 * infrastructure's services. The result keeps the composition's own fields and types and adds
 * inert `discovery` and an `acquire` that needs nothing but its owning Scope. Nothing is acquired,
 * provisioned or authenticated here. Throws on duplicate Provider ids, configured Models that name
 * no declared Provider, and Providers created by another copy of Core.
 */
export const defineMitome = <
  Input,
  A,
  E,
  R extends ROut | Turn | Scope.Scope | ModelServicesOf<Providers>,
  const Providers extends ReadonlyArray<
    Provider<string, ReadonlyArray<string>, typeof Schema.Unknown.Type, ROut>
  > = readonly [],
  ROut = never,
  EI = never,
  EP = never,
  RP extends ROut = never,
  ER = never,
  RR extends ROut = never,
  ES = never,
>(
  options: MitomeOptions<Input, A, E, R, Providers, ROut, EI, EP, RP, ER, RR, ES>,
): Mitome<Input, A, E, R, Providers, ROut, EI, EP, RP, ER, RR, ES> => {
  const providers: ReadonlyArray<AnyProvider> = options.providers ?? [];
  const ids = new Set<string>();
  const discovery = providers.map((provider) => {
    const metadata = getProviderMetadata(provider);
    if (metadata === undefined)
      throw new TypeError("Provider was not created by this copy of Core");
    if (ids.has(provider.id)) throw new TypeError(`Duplicate Provider id "${provider.id}"`);
    ids.add(provider.id);
    return {
      id: provider.id,
      modelIds: provider.modelIds,
      models: metadata.models,
      credential: metadata.credential,
    };
  });
  for (const id of [options.defaultModel, ...(options.fallbackModels ?? [])]) {
    if (id === undefined) continue;
    const parsed = parseQualifiedModelId(id);
    if (parsed === undefined || !ids.has(parsed.providerId)) {
      throw new TypeError(`Configured Model "${id}" names no declared Provider`);
    }
  }
  // SAFETY: the type parameters' constraints are the closure this cast relies on. The program's
  // requirements are the infrastructure's services, Turn, Scope and (only with Providers) the
  // Model services `acquire` provides; Provider, CLI and Host requirements are infrastructure
  // services; infrastructure needs nothing.
  const erased = options as ErasedOptions;
  return {
    ...options,
    protocol: mitomeProtocol,
    discovery,
    // SAFETY: `acquire` runs the same composition, so its values have exactly these types.
    acquire: (selection = {}) =>
      acquire(erased, selection) as Effect.Effect<
        Application<Input, A, E, ROut>,
        EI | ProvisionErrorOf<Providers[number]> | StepProtocolError | ModelSelectionError | ES,
        Scope.Scope
      >,
  };
};
