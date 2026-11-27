import { Effect, Predicate, type Types } from "effect";
import { Tool, type Toolkit } from "effect/ai";
import type { ToolDecision } from "../session/step.js";
import type { Turn } from "../session/turn.js";
import type { AnyAgent } from "./agent.js";
import type { Command } from "./command.js";
import type { AnyExtension, Extension, ToolCall } from "./extension.js";

// Module-private brands, so only values made by this copy of the package carry them.
export const ExtensionTypeId: unique symbol = Symbol("mitome/Extension");
export const AgentTypeId: unique symbol = Symbol("mitome/Agent");
export const CommandTypeId: unique symbol = Symbol("mitome/Command");

// The values each constructor returned: a copy, or an object inheriting from one, is not among them.
const made = {
  [ExtensionTypeId]: new WeakSet<object>(),
  [AgentTypeId]: new WeakSet<object>(),
  [CommandTypeId]: new WeakSet<object>(),
};

/** A frozen copy of `fields` with a non-enumerable brand, recorded as made by this copy. */
export const brand = <Fields extends object>(
  fields: Fields,
  typeId: typeof ExtensionTypeId | typeof AgentTypeId | typeof CommandTypeId,
): Readonly<Fields> => {
  const value = Object.freeze(Object.defineProperty({ ...fields }, typeId, { value: typeId }));
  made[typeId].add(value);
  return value;
};

/**
 * The fields `kind` defines, each read from `options` once, inherited ones included, so what is
 * validated is what is kept. Rejects an own field `kind` does not define, such as a misspelt one.
 */
export const snapshot = <Options extends object>(
  kind: string,
  options: Options,
  known: ReadonlyArray<keyof Options & string>,
): Types.Mutable<Options> => {
  for (const key of Object.keys(options)) {
    if (!known.some((name) => name === key)) throw new TypeError(`${kind} has no field "${key}"`);
  }
  const fields: Partial<Options> = {};
  for (const key of known) if (key in options) fields[key] = options[key];
  // SAFETY: every field `options` has under the names `kind` defines, and no other.
  return fields as Types.Mutable<Options>;
};

/** Whether a value is an Extension made by this copy of the package. */
export const isExtension = (value: unknown): value is AnyExtension =>
  Predicate.isObject(value) && made[ExtensionTypeId].has(value);

/** Whether a value is an Agent made by this copy of the package. */
export const isAgent = (value: unknown): value is AnyAgent =>
  Predicate.isObject(value) && made[AgentTypeId].has(value);

/** What any Extension adds, as a Session reads it. */
export interface AnyParts {
  readonly instructions?: string;
  readonly tools?: Toolkit.Any;
  readonly handlers?: unknown;
  readonly policy?: (call: ToolCall) => Effect.Effect<ToolDecision, unknown, unknown>;
  readonly commands?: ReadonlyArray<AnyCommand>;
}

/**
 * Nothing when `R` does not require the Turn; otherwise a field whose type says why, so that code
 * that never runs in a Turn, a setup or a Command, cannot require one.
 */
export type NoTurn<R, Where extends string> = [Extract<R, Turn>] extends [never]
  ? unknown
  : {
      readonly "~mitome/turn": `${Where} never runs in a Turn: look it up with Effect.serviceOption(Turn)`;
    };

/** Any Command, whatever its `run` fails with or needs. */
export type AnyCommand = Command<unknown, unknown>;

/** Whether a value is a Command made by this copy of the package. */
export const isCommand = (value: unknown): value is AnyCommand =>
  Predicate.isObject(value) && made[CommandTypeId].has(value);

/** Whether an Extension adds what its setup returns, rather than a record. */
export const isSetup = (
  parts: AnyExtension["parts"],
): parts is Effect.Effect<AnyParts, unknown, unknown> => Effect.isEffect(parts);

/** Whether a value is a Toolkit of ordinary Tool values. */
export const isToolkit = (value: unknown): value is Toolkit.Any =>
  // Effect does not export the Toolkit's type id, only this key.
  Predicate.hasProperty(value, "~effect/ai/Toolkit") &&
  Predicate.hasProperty(value, "tools") &&
  Predicate.isObject(value.tools) &&
  Object.values(value.tools).every((tool) => Predicate.hasProperty(tool, Tool.TypeId));

/** Whether `handlers` binds exactly the Tools of `toolkit`, as `localTools` requires. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- relates a Toolkit to an unchecked value; matching keys do not make it a handler map
export const bindsExactly = (toolkit: Toolkit.Any, handlers: unknown) => {
  if (!Predicate.isObject(handlers)) return false;
  const names = Object.keys(toolkit.tools);
  return (
    Object.keys(handlers).length === names.length &&
    names.every((name) => Object.hasOwn(handlers, name))
  );
};

/** The Agent's Tools: every Extension's Toolkit merged. */
export type AgentTools<Use> = Toolkit.MergeRecords<
  Use extends Extension<infer Tools, infer _E, infer _R> ? Tools : never
>;

/** How the Extensions' setups can fail. */
export type ExtensionError<Use> =
  Use extends Extension<infer _Tools, infer E, infer _R> ? E : never;

/** What the Extensions' setups, policies and Commands need from outside them. */
export type ExtensionRequirements<Use> =
  Use extends Extension<infer _Tools, infer _E, infer R> ? R : never;

const partFields: ReadonlyArray<keyof AnyParts> = [
  "instructions",
  "tools",
  "handlers",
  "policy",
  "commands",
];

/**
 * What an Extension adds, checked: a frozen copy holding its own copies of the handler map and the
 * Command list, so what is checked is what is kept. Throws a `TypeError` naming the Extension.
 */
export const checkParts = (name: string, given: AnyParts): AnyParts => {
  if (!Predicate.isObject(given) || Effect.isEffect(given)) {
    throw new TypeError(`Extension "${name}" must add a record`);
  }
  const parts = snapshot(`Extension "${name}"`, given, partFields);
  if (Predicate.isObject(parts.handlers) && !Effect.isEffect(parts.handlers)) {
    parts.handlers = Object.freeze({ ...parts.handlers });
  }
  if (Array.isArray(parts.commands)) parts.commands = Object.freeze([...parts.commands]);
  const { tools, handlers, instructions, policy, commands } = parts;
  if ((tools === undefined) !== (handlers === undefined)) {
    throw new TypeError(`Extension "${name}" must give handlers exactly when it gives tools`);
  }
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- typed by the declaration but unchecked: a JavaScript caller can pass anything
  if (tools !== undefined && !isToolkit(tools)) {
    throw new TypeError(`Extension "${name}" tools must be a Toolkit`);
  }
  if (handlers !== undefined && (!Predicate.isObject(handlers) || Effect.isEffect(handlers))) {
    throw new TypeError(`Extension "${name}" handlers must be a handler map`);
  }
  if (tools !== undefined && !bindsExactly(tools, handlers)) {
    throw new TypeError(`Extension "${name}" handlers must match its Toolkit's Tools exactly`);
  }
  for (const [tool, handler] of Object.entries(handlers ?? {})) {
    if (!Predicate.isFunction(handler)) {
      throw new TypeError(`Extension "${name}" handler "${tool}" must be a function`);
    }
  }
  if (instructions !== undefined && !Predicate.isString(instructions)) {
    throw new TypeError(`Extension "${name}" instructions must be a string`);
  }
  if (policy !== undefined && !Predicate.isFunction(policy)) {
    throw new TypeError(`Extension "${name}" policy must be a function`);
  }
  if (commands !== undefined) {
    if (!Array.isArray(commands) || !commands.every(isCommand)) {
      throw new TypeError(
        `Extension "${name}" commands must be a list of Commands made by Command.make`,
      );
    }
    const names = new Set<string>();
    for (const command of commands) {
      if (names.has(command.name)) {
        throw new TypeError(`Extension "${name}" has two Commands named "${command.name}"`);
      }
      names.add(command.name);
    }
  }
  return Object.freeze(parts);
};

/**
 * Throws a `TypeError` naming both Extensions when two define a Tool or a Command of one name.
 * What a setup adds is `undefined` until a Session runs it.
 */
export const checkClashes = (
  extensions: ReadonlyArray<{ readonly name: string; readonly parts: AnyParts | undefined }>,
) => {
  const tools = new Map<string, string>();
  const commands = new Map<string, string>();
  for (const { name, parts } of extensions) {
    // By Tool name, which is what the Model calls, whatever key the Toolkit holds it under.
    for (const tool of new Set(Object.values(parts?.tools?.tools ?? {}).map((t) => t.name))) {
      const owner = tools.get(tool);
      if (owner !== undefined) {
        throw new TypeError(
          `Tool "${tool}" is defined by both Extension "${owner}" and Extension "${name}"`,
        );
      }
      tools.set(tool, name);
    }
    for (const { name: command } of parts?.commands ?? []) {
      const owner = commands.get(command);
      if (owner !== undefined) {
        throw new TypeError(
          `Command "${command}" is defined by both Extension "${owner}" and Extension "${name}"`,
        );
      }
      commands.set(command, name);
    }
  }
};
