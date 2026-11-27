import { Predicate, Result } from "effect";
import type { Effect } from "effect";
import type { loop, step, ToolCallRequest, ToolDecision } from "../session/step.js";
import { readLimits } from "../session/turn.js";
import type { ExecutionLimits } from "../session/turn.js";
import type { TextMappingError } from "./errors.js";
import type { AnyExtension } from "./extension.js";
import { AgentTypeId, brand, checkClashes, isExtension, isSetup, snapshot } from "./internal.js";
import type { AgentTools } from "./internal.js";

/** How a text Host turns text into the Agent's input and its result back into text. */
export interface TextMapping<
  Input,
  A,
  EParse = never,
  RParse = never,
  ERender = EParse,
  RRender = RParse,
> {
  readonly parse: (text: string) => Effect.Effect<Input, EParse, RParse>;
  readonly render: (result: A) => Effect.Effect<string, ERender, RRender>;
}

/**
 * The standard `step` and `loop` with the Agent's merged Instructions, Tools, policy and
 * Extension policies already applied, so a custom program composes with `use`.
 */
export interface AgentSteps<Use extends ReadonlyArray<AnyExtension>, RPolicy> {
  readonly step: ReturnType<typeof step<AgentTools<Use[number]>, RPolicy>>;
  readonly loop: ReturnType<typeof loop<AgentTools<Use[number]>, RPolicy>>;
}

/** An Agent's program: one Turn's work for one input. */
type Program<Input, A, E, R, Use extends ReadonlyArray<AnyExtension>, RPolicy> = (
  input: Input,
  steps: AgentSteps<Use, RPolicy>,
) => Effect.Effect<A, E, R>;

/** What `Agent.make` accepts. */
export interface AgentOptions<
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
> {
  /** Comes first in the merged Instructions, before each Extension's. */
  readonly instructions?: string;
  /** Extensions, in order. */
  readonly use?: Use;
  /**
   * Decides each Tool Call, replacing the Tool's own `needsApproval` flag as `StepOptions.policy`
   * does. Extension policies can then only tighten the decision. An `ask` is answered by the
   * Host's Approver, which Extensions and Tool handlers never see; the program is the author's own
   * code and may provide its own.
   */
  readonly policy?: (
    call: ToolCallRequest<AgentTools<Use[number]>>,
  ) => Effect.Effect<ToolDecision, unknown, RPolicy>;
  /** Bounds on each Turn; without them a Turn has no limit. */
  readonly limits?: ExecutionLimits;
  /**
   * The ordinary program run as one Turn per input. Without it the input is staged as a user
   * Message, `loop` runs and the final Step's text is the result.
   */
  readonly program?: Program<Input, A, E, R, Use, RPolicy>;
  /** Required unless the program accepts any string and returns a string (the identity). */
  readonly text?: TextMapping<NoInfer<Input>, NoInfer<A>, EParse, RParse, ERender, RRender>;
}

/**
 * A text mapping is required unless the program accepts any string, not just some, and returns a
 * string: only then is the identity a mapping.
 */
type TextRequired<Input, A, Text> = [string, A] extends [Input, string]
  ? unknown
  : { readonly text: Text };

/** What the default program can fail with: the merged `loop`'s errors. */
type DefaultError<Use extends ReadonlyArray<AnyExtension>, RPolicy> = Effect.Error<
  AgentSteps<Use, RPolicy>["loop"]
>;

/** What the default program needs: the merged `loop`'s services, among them the Turn. */
type DefaultServices<Use extends ReadonlyArray<AnyExtension>, RPolicy> = Effect.Services<
  AgentSteps<Use, RPolicy>["loop"]
>;

/**
 * Where an Agent without a program types its absent `program`: the default's types, marked so that
 * an author's function is never taken for it and `Agent.make({ ...agent })` keeps the default. The
 * mark is a string key so that a consumer's declarations can name an Agent's inferred type.
 */
type DefaultProgram<Use extends ReadonlyArray<AnyExtension>, RPolicy> = Program<
  string,
  string,
  DefaultError<Use, RPolicy>,
  DefaultServices<Use, RPolicy>,
  Use,
  RPolicy
> & { readonly "~mitome/DefaultProgram": never };

/**
 * An Agent described as plain data: what it is told, which Extensions it uses, how it decides
 * Tool Calls, its program and its text mapping. It knows nothing about where it runs. `EParse`
 * to `RRender` describe the text mapping a Host uses: without one, the identity, whose renderer
 * fails with `TextMappingError` on a result that is not a string.
 */
export interface Agent<
  Input = string,
  A = string,
  E = never,
  R = never,
  Use extends ReadonlyArray<AnyExtension> = readonly [],
  RPolicy = never,
  EParse = never,
  RParse = never,
  ERender = TextMappingError,
  RRender = never,
> extends AgentOptions<Input, A, E, R, Use, RPolicy, EParse, RParse, ERender, RRender> {
  /** @internal */
  readonly [AgentTypeId]: typeof AgentTypeId;
}

/** Any Agent; `any` because its program's input is contravariant. */
export type AnyAgent = Agent<any, any, any, any, ReadonlyArray<any>, any, any, any, any, any>;

const fields: ReadonlyArray<keyof AgentOptions<any, any, any, any, any, any, any, any, any, any>> =
  ["instructions", "use", "policy", "limits", "program", "text"];

/** Whether given limits are a record, which is copied before its bounds are checked. */
const isRecord = (limits: ExecutionLimits | undefined): limits is ExecutionLimits =>
  Predicate.isObject(limits);

/**
 * Describes an Agent. Validates the fields and returns them frozen; nothing is built, registered
 * or read until the Agent runs. Throws when two Extensions share a name, when two given as records
 * define a Tool or a Command of one name, when a limit given is not a non-negative integer, or when
 * a key of `limits` names no bound; a clash that involves a setup's record fails `Session.make`
 * instead. Override part of an Agent with `Agent.make({ ...agent, instructions })`.
 *
 * With a program, the Agent's types are the program's; without one, the input and result are
 * `string` and the errors and requirements are those of the merged `loop` the default runs.
 */
export function make<
  const Use extends ReadonlyArray<AnyExtension> = readonly [],
  RPolicy = never,
  EParse = never,
  RParse = never,
  ERender = TextMappingError,
  RRender = never,
>(
  options: AgentOptions<
    string,
    string,
    DefaultError<Use, RPolicy>,
    DefaultServices<Use, RPolicy>,
    Use,
    RPolicy,
    EParse,
    RParse,
    ERender,
    RRender
  > & { readonly program?: DefaultProgram<Use, RPolicy> },
): Agent<
  string,
  string,
  DefaultError<Use, RPolicy>,
  DefaultServices<Use, RPolicy>,
  Use,
  RPolicy,
  EParse,
  RParse,
  ERender,
  RRender
> & { readonly program?: DefaultProgram<Use, RPolicy> };
export function make<
  const Use extends ReadonlyArray<AnyExtension> = readonly [],
  RPolicy = never,
  Input = string,
  A = string,
  E = never,
  R = never,
  EParse = never,
  RParse = never,
  ERender = TextMappingError,
  RRender = never,
>(
  options: AgentOptions<Input, A, E, R, Use, RPolicy, EParse, RParse, ERender, RRender> & {
    readonly program: Program<Input, A, E, R, Use, RPolicy>;
  } & TextRequired<Input, A, unknown>,
): Agent<Input, A, E, R, Use, RPolicy, EParse, RParse, ERender, RRender> & {
  readonly program: Program<Input, A, E, R, Use, RPolicy>;
} & TextRequired<Input, A, TextMapping<Input, A, EParse, RParse, ERender, RRender>>;
export function make(options: AgentOptions<any, any, any, any, any, any, any, any, any, any>) {
  const agent = snapshot("Agent", options, fields);
  if (agent.use !== undefined && !Array.isArray(agent.use)) {
    throw new TypeError("Agent use must be an array of Extensions");
  }
  // `use` and `limits` are copied first, so what is checked is what is kept.
  if (agent.use !== undefined) {
    agent.use = Object.freeze([...agent.use]);
  }
  const read = isRecord(agent.limits)
    ? readLimits(agent.limits)
    : Result.fail("must be non-negative integers");
  if (Result.isSuccess(read)) {
    agent.limits = Object.freeze(read.success);
  }
  const { instructions, use = [], policy, limits, program, text } = agent;
  if (instructions !== undefined && !Predicate.isString(instructions)) {
    throw new TypeError("Agent instructions must be a string");
  }
  const names = new Set<string>();
  for (const [index, extension] of use.entries()) {
    if (!isExtension(extension)) {
      throw new TypeError(`Agent use[${index}] is not an Extension made by Extension.make`);
    }
    if (names.has(extension.name)) {
      throw new TypeError(`Two Extensions are named "${extension.name}"`);
    }
    names.add(extension.name);
  }
  // What a setup adds is checked when a Session runs it.
  checkClashes(
    use.map(({ name, parts }: AnyExtension) => ({
      name,
      parts: isSetup(parts) ? undefined : parts,
    })),
  );
  if (policy !== undefined && !Predicate.isFunction(policy)) {
    throw new TypeError("Agent policy must be a function");
  }
  if (limits !== undefined && Result.isFailure(read)) {
    throw new TypeError(`Agent limits ${read.failure}`);
  }
  if (program !== undefined && !Predicate.isFunction(program)) {
    throw new TypeError("Agent program must be a function");
  }
  if (
    text !== undefined &&
    !(Predicate.isFunction(text.parse) && Predicate.isFunction(text.render))
  ) {
    throw new TypeError("Agent text must have parse and render functions");
  }
  return brand(agent, AgentTypeId);
}
