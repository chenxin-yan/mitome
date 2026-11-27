import { Data, Predicate } from "effect";
import type { Effect } from "effect";
import { brand, CommandTypeId, snapshot } from "./internal.js";
import type { NoTurn } from "./internal.js";

/** What the Host does after a Command: show text to the person, or start a Turn with an input. */
export type Result = Data.TaggedEnum<{
  Reply: { readonly text: string };
  Prompt: { readonly text: string };
}>;

const { Reply, Prompt } = Data.taggedEnum<Result>();

/** Show `text` to the person. */
export const reply = (text: string): Result => Reply({ text });

/** Start a Turn with `text` as its input. */
export const prompt = (text: string): Result => Prompt({ text });

/** A named ability a person invokes by typing `/name`. `E` and `R` are those of its `run`. */
export interface Command<E = never, R = never> {
  /** @internal */
  readonly [CommandTypeId]: typeof CommandTypeId;
  readonly name: string;
  /** One line of at most 100 characters, shown where Commands are listed. */
  readonly description: string;
  /** Runs with the text after the Command's name; never inside a Turn. */
  readonly run: (input: string) => Effect.Effect<Result, E, R>;
}

const namePattern = "[a-z][a-z0-9_]{0,30}";
const validName = new RegExp(`^${namePattern}$`);
const named = new RegExp(`^/(${namePattern})(?:\\s+|$)`);

/**
 * Describes a Command an Extension lists. The name is a lowercase letter followed by at most 30
 * lowercase letters, digits or underscores; the description is one non-empty line of at most 100
 * characters. Throws a `TypeError` otherwise.
 */
export const make = <E = never, R = never>(
  name: string,
  options: Pick<Command<E, R>, "description" | "run"> & NoTurn<R, "A Command">,
): Command<E, R> => {
  if (!Predicate.isString(name) || !validName.test(name)) {
    throw new TypeError(
      `Command name "${String(name)}" must be a lowercase letter followed by at most 30 lowercase letters, digits or underscores`,
    );
  }
  const given: Pick<Command<E, R>, "description" | "run"> = options;
  const { description, run } = snapshot(`Command "${name}"`, given, ["description", "run"]);
  if (
    !Predicate.isString(description) ||
    description.length === 0 ||
    description.length > 100 ||
    /[\r\n\u0085\u2028\u2029]/.test(description)
  ) {
    throw new TypeError(
      `Command "${name}" description must be one non-empty line of at most 100 characters`,
    );
  }
  if (!Predicate.isFunction(run)) {
    throw new TypeError(`Command "${name}" run must be a function`);
  }
  // SAFETY: the same fields, branded.
  return brand({ name, description, run }, CommandTypeId) as Command<E, R>;
};

/**
 * The Command an input names: only an input whose first character is `/`, followed by a Command
 * name and then whitespace or the end. `input` is the rest, without the whitespace after the name.
 * Anything else is ordinary text, `undefined`.
 */
export const parse = (
  text: string,
): { readonly name: string; readonly input: string } | undefined => {
  const found = named.exec(text);
  return found?.[1] === undefined
    ? undefined
    : { name: found[1], input: text.slice(found[0].length) };
};
