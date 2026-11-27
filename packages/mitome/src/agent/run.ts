import { Context, Effect, Exit, Fiber, Scope } from "effect";
import type { Types } from "effect";
import { Prompt, Toolkit } from "effect/ai";
import type { Tool } from "effect/ai";
import { Approver } from "../session/approver.js";
import type { SessionFencedError, SessionSaveError } from "../session/errors.js";
import { sessionOwned } from "../session/internal.js";
import { make } from "../session/session.js";
import type { Session as KernelSession } from "../session/session.js";
import { localTools, loop, step } from "../session/step.js";
import type { StepOptions } from "../session/step.js";
import { Turn } from "../session/turn.js";
import type { AnyAgent } from "./agent.js";
import { CommandFailedError, CommandNotFoundError, TranscriptSelectionError } from "./errors.js";
import { checkClashes, checkParts, isSetup } from "./internal.js";
import type { AnyCommand } from "./internal.js";
import type { AnyExtension } from "./extension.js";
import type { SessionOptions } from "./session.js";
import { Transcripts } from "./transcripts.js";

/** The Agent's Step options, filled in field by field because an absent field must stay absent. */
type MergedStepOptions = Types.Mutable<StepOptions<Record<string, Tool.Any>, unknown>>;

/** Stages the input as a user Message, runs `loop` and returns the final Step's text. */
const defaultProgram = Effect.fnUntraced(function* (
  input: string,
  steps: { readonly loop: ReturnType<typeof loop> },
) {
  const turn = yield* Turn;
  yield* turn.stage(Prompt.userMessage({ content: [Prompt.textPart({ text: input })] }));
  const result = yield* steps.loop;
  return result.response.text;
});

/** The Transcript a Host selected from the `Transcripts` in context; `undefined` keeps memory. */
const selectTranscript = Effect.fnUntraced(function* (
  selection: NonNullable<SessionOptions["transcript"]>,
) {
  const transcripts = yield* Transcripts;
  // By value, not by key: a consumer compiling without `exactOptionalPropertyTypes` can pass the
  // other keys as `undefined`, and those must not win over the one it named.
  const { latest, open } = selection;
  if (latest === undefined && open === undefined) {
    return transcripts === undefined ? undefined : yield* transcripts.create(selection.create);
  }
  if (transcripts === undefined) {
    return yield* new TranscriptSelectionError({ reason: "no-store" });
  }
  const found = yield* open === undefined ? transcripts.latest(latest) : transcripts.open(open);
  if (found === undefined) {
    return yield* new TranscriptSelectionError({ reason: "not-found" });
  }
  return found;
});

/**
 * Runs the setups one after another in `use` order, so each one's resources are released in
 * reverse, checks what each returns and registers the Tools, all on the fiber `allocate` starts
 * with the services Extension code is given.
 */
const prepare = Effect.fnUntraced(function* (use: ReadonlyArray<AnyExtension>) {
  const added = yield* Effect.forEach(use, ({ name, parts }) =>
    isSetup(parts)
      ? Effect.flatMap(parts, (given) => Effect.sync(() => checkParts(name, given)))
      : Effect.succeed(parts),
  );
  yield* Effect.sync(() =>
    checkClashes(use.map(({ name }, index) => ({ name, parts: added[index] }))),
  );
  const toolkits = added.flatMap(({ tools }) => (tools === undefined ? [] : [tools]));
  const tools =
    toolkits.length === 0
      ? undefined
      : yield* localTools(
          Toolkit.merge(...toolkits),
          // Each map was checked against its own Toolkit, so no Extension binds another's Tool. No
          // prototype, so a Tool named `__proto__` keeps an own handler.
          // oxlint-disable-next-line typescript/no-unsafe-argument -- no type relates the merged handler maps to the merged Toolkit
          Object.assign(Object.create(null), ...added.map(({ handlers }) => handlers)),
        );
  return { added, tools };
});

const allocate = Effect.fnUntraced(function* (
  agent: AnyAgent,
  selection: SessionOptions,
  scope: Scope.Scope,
) {
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- `AnyAgent` erases its Extensions to `any`, and `Agent.make` checked each
  const use: ReadonlyArray<AnyExtension> = agent.use ?? [];
  // What the setups acquire. Forked before anything else joins `scope`, so it is released last:
  // after the Session has drained its Turns and Commands, even of a finalizer added to it late.
  const setupScope = yield* Scope.fork(scope, "sequential");
  // What Extension code runs with: the setups' own Scope and whatever the Session's maker
  // provides, but never the Host's Approver, the conversations' store, or a Turn the Session is
  // made in. This keeps them from being reached through the services Extension code is given; it
  // is not a sandbox against code that reads fiber internals.
  const services = Context.add(
    Context.add(
      Context.add(Context.omit(Turn)(yield* Effect.context<unknown>()), Approver, undefined),
      Transcripts,
      undefined,
    ),
    Scope.Scope,
    setupScope,
  );
  // Forked with those services alone, so the fiber the setups run on never held the Host's; owned
  // by `scope`, so closing it interrupts and awaits a setup still running before its release.
  const preparing = yield* Effect.setContext(Effect.forkIn(prepare(use), scope), services);
  const { added, tools } = yield* Fiber.join(preparing).pipe(
    Effect.ensuring(Fiber.interrupt(preparing)),
  );
  // A policy runs with the services of the Step that runs it, those the setup had replacing the
  // same services there, apart from the setup's Scope: whoever runs the Turn, the Host or the
  // embedding application, is trusted more than an Extension, and a policy's logs and traces stay
  // with its Turn.
  const policyServices = Context.omit(Scope.Scope)(services);
  const options: MergedStepOptions = {
    restrictions: added.flatMap(({ policy }) =>
      policy === undefined
        ? []
        : [
            (call) =>
              Effect.updateContext(
                Effect.suspend(() => policy(call)),
                (step: Context.Context<unknown>) => Context.merge(step, policyServices),
              ),
          ],
    ),
  };
  if (tools !== undefined) {
    options.tools = tools;
  }
  const instructions = [agent, ...added].flatMap(({ instructions }) =>
    instructions === undefined ? [] : [instructions],
  );
  if (instructions.length > 0) {
    options.instructions = instructions.join("\n\n");
  }
  if (agent.policy !== undefined) {
    options.policy = agent.policy;
  }
  const commands = new Map<string, AnyCommand>();
  const listed = use.flatMap(({ name: extension }, index) =>
    (added[index]?.commands ?? []).map((command) => {
      commands.set(command.name, command);
      const { name, description } = command;
      return Object.freeze({ name, description, extension });
    }),
  );
  const program = agent.program ?? defaultProgram;
  const limits = agent.limits ?? {};
  const transcript = yield* selectTranscript(selection.transcript ?? { create: "" });
  const session: KernelSession<SessionSaveError | SessionFencedError> =
    transcript === undefined
      ? yield* make({ transcript: "none", limits })
      : yield* make({ transcript, limits });
  // In another Session's Turn the policies and handlers would use what this Session's setups
  // acquired, which its release frees.
  const ownTurn = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(Turn, (turn) =>
      turn.session === session
        ? effect
        : Effect.die(
            new Error(
              "The step and loop given to an Agent's program run only in Turns of the Session that gave them",
            ),
          ),
    );
  const steps = { step: ownTurn(step(options)), loop: ownTurn(loop(options)) };
  // The Session's release interrupts and awaits a running Command before any setup's finalizer.
  const owned = sessionOwned(session);
  return {
    transcript: session.transcript,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- forwards to an Agent program whose input type is erased here
    run: (input: unknown) =>
      session.run(
        Effect.suspend(() => program(input, steps)).pipe(
          // Innermost, so the caller cannot hand it to Agent code.
          Effect.provideService(Transcripts, undefined),
        ),
      ),
    history: session.history,
    position: session.position,
    moveTo: session.moveTo,
    tree: session.tree,
    turns: session.turns,
    commands: Object.freeze(listed),
    command: (name: string, input: string) =>
      owned(
        Effect.gen(function* () {
          const command = commands.get(name);
          if (command === undefined) {
            return yield* new CommandNotFoundError({ command: name });
          }
          // In a Scope of its own, so what it acquires is released when it ends.
          return yield* Effect.scopedWith((own) =>
            Effect.setContext(
              Effect.suspend(() => command.run(input)),
              Context.add(services, Scope.Scope, own),
            ),
          ).pipe(Effect.mapError((cause) => new CommandFailedError({ command: name, cause })));
        }),
      ),
  };
});

/**
 * Allocates a Session that runs `agent`, as `Session.make(agent, selection)` does, in one
 * sequential Scope the caller's Scope owns. Closing it, or failing to complete construction,
 * releases in this order: a setup still running is interrupted, the Session drains its Turns and
 * Commands, then what the setups acquired is released, whatever the caller's finalizer strategy.
 */
export const agentSession = (agent: AnyAgent, selection: SessionOptions = {}) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const scope = yield* Scope.fork(yield* Effect.scope, "sequential");
      return yield* restore(allocate(agent, selection, scope)).pipe(
        Scope.provide(scope),
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
      );
    }),
  );
