/**
 * The terminal's options: the keys it binds, given to a Configuration in its `provide` by
 * `terminal({ keys })`. Plain data; the terminal Host reads and checks them when it opens.
 *
 * @module @mitome/core/terminal
 */
import { Context, Layer, Predicate } from "effect";

/**
 * One of the terminal's controls, recognised by its `id`: the terminal and a Configuration may
 * load different copies of this package, so a control is never compared by identity.
 */
export interface Control {
  readonly id: "mitome/terminal/submit" | "mitome/terminal/newline" | "mitome/terminal/interrupt";
}

/** What a key does: a control, or text the terminal types into an empty input and sends. */
export type Binding = Control | `/${string}`;

/** What the terminal reads from a Configuration. */
export interface Options {
  /** Each key, written as `ctrl+alt+shift+name` with only the modifiers it needs, and what it does. */
  readonly keys: Readonly<Record<string, Binding>>;
}

/**
 * The terminal's options, absent unless a Configuration provides them with `terminal`. Keyed by a
 * stable string because the CLI and a Configuration may load different copies of this package
 * and must still find each other's.
 */
export const TerminalOptions = Context.Reference<Options | undefined>("mitome/TerminalOptions", {
  defaultValue: () => undefined,
});

const control = (id: Control["id"]): Control => Object.freeze({ id });
const submit = control("mitome/terminal/submit");
const newline = control("mitome/terminal/newline");
const interrupt = control("mitome/terminal/interrupt");
const controlIds: ReadonlySet<string> = new Set([submit.id, newline.id, interrupt.id]);

const keyName =
  "(?:[a-z0-9]|enter|escape|tab|space|backspace|delete|up|down|left|right|home|end|pageup|pagedown|f(?:[1-9]|1[0-2]))";
const keyNotation = new RegExp(`^(?:ctrl\\+)?(?:alt\\+)?(?:shift\\+)?${keyName}$`);

const isBinding = (value: unknown): value is Binding =>
  (Predicate.isString(value) && value.startsWith("/")) ||
  (Predicate.hasProperty(value, "id") && Predicate.isString(value.id) && controlIds.has(value.id));

const make = (options: Options): Layer.Layer<never> => {
  if (!Predicate.isObject(options)) {
    throw new TypeError("terminal options must be a record");
  }
  for (const field of Object.keys(options)) {
    if (field !== "keys") {
      throw new TypeError(`terminal has no field "${field}"`);
    }
  }
  const { keys } = options;
  if (!Predicate.isObject(keys) || Array.isArray(keys)) {
    throw new TypeError("terminal keys must be a record of keys and what each does");
  }
  const copy: Record<string, Binding> = {};
  for (const [key, binding] of Object.entries(keys)) {
    if (!keyNotation.test(key)) {
      throw new TypeError(
        `Key "${key}" must be written in lowercase as its modifiers ctrl, alt and shift, in that order, then one key name, joined by +, such as ctrl+d`,
      );
    }
    if (!isBinding(binding)) {
      throw new TypeError(
        `Key "${key}" must be bound to terminal.submit, terminal.newline, terminal.interrupt or text starting with /`,
      );
    }
    copy[key] = binding;
  }
  return Layer.succeed(TerminalOptions, Object.freeze({ keys: Object.freeze(copy) }));
};

/**
 * A Layer that gives the terminal these options, for a Configuration's `provide`. A key is written
 * in lowercase as its modifiers, in the order `ctrl`, `alt`, `shift`, then one key name, joined by
 * `+`: a letter `a`-`z`, a digit `0`-`9`, `enter`, `escape`, `tab`, `space`, `backspace`, `delete`,
 * `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown` or `f1`-`f12`. Each key is
 * bound to `terminal.submit`, `terminal.newline`, `terminal.interrupt`, or text starting with `/`.
 * Throws a `TypeError` otherwise. There are no default keys; the terminal checks, when it opens,
 * that one sends the input and that it can tell each key apart.
 */
export const terminal: typeof make & {
  /** Sends the input. */
  readonly submit: Control;
  /** Starts a new line in the input. */
  readonly newline: Control;
  /** Interrupts what the terminal is running, such as a Turn. */
  readonly interrupt: Control;
} = Object.freeze(Object.assign(make, { submit, newline, interrupt }));
