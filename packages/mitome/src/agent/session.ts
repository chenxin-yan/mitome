import { Effect, type Scope } from "effect";
import type {
  SessionBusyError,
  SessionFencedError,
  SessionReleasedError,
  SessionSaveError,
  ToolRegistrationError,
  TranscriptError,
} from "../session/errors.js";
import type { Session as KernelSession } from "../session/session.js";
import type { Turn } from "../session/turn.js";
import type { Agent, AnyAgent } from "./agent.js";
import type { Result } from "./command.js";
import type {
  CommandFailedError,
  CommandNotFoundError,
  TranscriptSelectionError,
} from "./errors.js";
import type { AnyExtension } from "./extension.js";
import { type ExtensionError, type ExtensionRequirements, isAgent } from "./internal.js";
import { agentSession } from "./run.js";

export type { Entry, Transcript, TurnSnapshot } from "../session/session.js";

/** A Session that runs one Agent; it lives until the Scope that allocated it closes. */
export interface Session<in Input, out A, out E, out R> extends Pick<
  KernelSession<SessionSaveError | SessionFencedError>,
  "transcript" | "history" | "position" | "moveTo" | "tree" | "turns"
> {
  /** Runs the Agent's program for `input` as one Turn of this Session. */
  readonly run: (
    input: Input,
  ) => Effect.Effect<
    A,
    E | SessionBusyError | SessionReleasedError | SessionSaveError | SessionFencedError,
    R
  >;
  /** The Commands of the Agent's Extensions, in `use` order. */
  readonly commands: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly extension: string;
  }>;
  /**
   * Runs the Command `name` with `input`, with what its Extension's setup holds and the services
   * the setup had. It never runs inside a Turn and never starts one, whether or not a Turn is
   * running: a `prompt` result is for the Host to act on. Closing the Session interrupts it.
   */
  readonly command: (
    name: string,
    input: string,
  ) => Effect.Effect<Result, CommandNotFoundError | CommandFailedError | SessionReleasedError>;
}

/** Which conversation a Session that runs an Agent keeps its History tree in. */
export interface SessionOptions {
  /**
   * A conversation from the `Transcripts` service in context: a new one under a scope (`create`,
   * the default, with the scope `""`), the latest written under a scope (`latest`), or one by id
   * (`open`). Without that service `create` keeps history in memory, and `latest` and `open` fail
   * with `TranscriptSelectionError`, as they do when it has no such conversation. Exactly one of
   * the three is named, so a spread default cannot silently win over the one asked for; a key
   * given as `undefined` counts as absent.
   */
  readonly transcript?:
    | { readonly create: string; readonly latest?: never; readonly open?: never }
    | { readonly latest: string; readonly create?: never; readonly open?: never }
    | { readonly open: string; readonly create?: never; readonly latest?: never };
}

/**
 * Allocates a fresh Session in the current Scope that runs `agent`'s program with the Agent's
 * limits, in the conversation `options` selects (see `SessionOptions`). Closing that Scope
 * rejects new Turns, interrupts and drains an active Turn (a commit under way still completes) and
 * then releases every live record. Each call is a new Session; Sessions opened on one Transcript
 * share only what it stores, and a stale one is fenced by its next commit. Its Extensions' setups
 * run one after another in `use` order, here, and their Tools are registered once; what the setups
 * acquired is released with the Scope after the Session. A setup's failure fails this, releasing
 * what earlier ones acquired; a malformed record or a clash it causes is a defect. What the
 * setups, policies and Commands need is required here; what the program needs, such as the Model,
 * stays a requirement of `run`.
 */
export function make<
  Input,
  A,
  E,
  R,
  Use extends ReadonlyArray<AnyExtension>,
  RPolicy,
  EParse,
  RParse,
  ERender,
  RRender,
>(
  agent: Agent<Input, A, E, R, Use, RPolicy, EParse, RParse, ERender, RRender>,
  options?: SessionOptions,
): Effect.Effect<
  Session<Input, A, E, Exclude<R, Turn | Scope.Scope>>,
  ExtensionError<Use[number]> | ToolRegistrationError | TranscriptError | TranscriptSelectionError,
  Scope.Scope | ExtensionRequirements<Use[number]>
>;
export function make(value: AnyAgent, options?: SessionOptions) {
  return isAgent(value)
    ? agentSession(value, options)
    : Effect.die(new TypeError("Session.make expects an Agent made by Agent.make"));
}
