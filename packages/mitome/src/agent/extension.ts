import { Effect, Predicate } from "effect";
import type { Scope } from "effect";
import type { Tool, Toolkit } from "effect/ai";
import type { ToolDecision } from "../session/step.js";
import type { Turn } from "../session/turn.js";
import type { Command } from "./command.js";
import { brand, checkParts, ExtensionTypeId } from "./internal.js";
import type { AnyCommand, AnyParts, NoTurn } from "./internal.js";

/**
 * Any Tool Call of the Agent, as an Extension policy sees it. The Tool may belong to another
 * Extension, so its parameters are not typed.
 */
export interface ToolCall {
  readonly toolCallId: string;
  readonly name: string;
  readonly params: unknown;
}

/** What an Extension adds, with the type of its Command list kept as given. */
interface Given<Tools extends Record<string, Tool.Any>, R, Commands> {
  /** Appended to the Agent's own Instructions in `use` order. */
  readonly instructions?: string;
  /** Tools this Extension adds; requires `handlers`. */
  readonly tools?: Toolkit.Toolkit<Tools>;
  /** The handlers for `tools`, a plain map (`toolkit.of`); required exactly with `tools`. */
  readonly handlers?: Toolkit.HandlersFrom<Tools>;
  /** Sees every Tool Call of the Agent after the Agent's decision and can only tighten it. */
  readonly policy?: (call: ToolCall) => Effect.Effect<ToolDecision, unknown, R>;
  /** Commands a person can invoke, each name used once in the Agent. */
  readonly commands?: Commands;
}

/**
 * What an Extension adds to an Agent. `R` is what its policy and Commands need from outside; the
 * policy may also need the Turn and the Scope of the Step that runs it, and a Command the Scope
 * each of its calls is given.
 */
export type Parts<Tools extends Record<string, Tool.Any> = {}, R = never> = Given<
  Tools,
  R | StepServices,
  ReadonlyArray<Command<unknown, R | Scope.Scope>>
>;

/**
 * A name and what it adds to an Agent, as plain data. `E` is how its setup can fail and `R` what
 * its setup, policy and Commands need from outside.
 */
export interface Extension<Tools extends Record<string, Tool.Any> = {}, E = never, R = never> {
  /** @internal */
  readonly [ExtensionTypeId]: typeof ExtensionTypeId;
  /** Unique within an Agent. */
  readonly name: string;
  /** The record, or the setup that returns it once per Session, in that Session's Scope. */
  readonly parts: Parts<Tools, R> | Effect.Effect<Parts<Tools, R>, E, R | Scope.Scope>;
}

/** What the Step a policy runs in supplies to it, so an Extension never needs it from outside. */
type StepServices = Turn | Scope.Scope;

/** Any Extension, whatever it adds. */
export interface AnyExtension {
  /** @internal */
  readonly [ExtensionTypeId]: typeof ExtensionTypeId;
  readonly name: string;
  readonly parts: AnyParts | Effect.Effect<AnyParts, unknown, unknown>;
}

/**
 * Describes an Extension: a name and what it adds, as a record or as an Effect that returns one.
 * A record is checked here and kept as a frozen copy. An Effect is the Extension's setup: it runs
 * once each time a Session is made from an Agent using it, in that Session's Scope, so what it
 * acquires lives until the Session closes; its record is checked then. The setup, its handlers,
 * policy and Commands never see the Approver or `Transcripts`.
 */
export const make = <
  Tools extends Record<string, Tool.Any> = {},
  RP = never,
  Commands extends ReadonlyArray<AnyCommand> = readonly [],
  E = never,
  RS = never,
>(
  name: string,
  parts: (Given<Tools, RP, Commands> | Effect.Effect<Given<Tools, RP, Commands>, E, RS>) &
    NoTurn<RS, "A setup">,
  // Inferred from `parts` alone: where an Extension is expected, such as in `use`, any would do.
): NoInfer<
  Extension<
    Tools,
    E,
    | Exclude<RP, StepServices>
    | Exclude<Effect.Services<ReturnType<Commands[number]["run"]>>, Scope.Scope>
    | Exclude<RS, Scope.Scope>
  >
> => {
  if (!Predicate.isString(name) || name.length === 0) {
    throw new TypeError("Extension name must be a non-empty string");
  }
  const extension = { name, parts: Effect.isEffect(parts) ? parts : checkParts(name, parts) };
  // SAFETY: the same fields, branded. `R` leaves out what the Session supplies: the setup's Scope
  // is the Session's own, a Command's Scope is its call's, and a policy's Turn and Scope are those
  // of the Step that runs it; `Parts` keeps them on the policy and the Commands.
  return brand(extension, ExtensionTypeId) as Extension<
    Tools,
    E,
    | Exclude<RP, StepServices>
    | Exclude<Effect.Services<ReturnType<Commands[number]["run"]>>, Scope.Scope>
    | Exclude<RS, Scope.Scope>
  >;
};
