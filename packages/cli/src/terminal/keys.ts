/** The terminal's keys and its own Commands. */

import { type Binding, type Control, type Options, terminal } from "@mitome/core/terminal";
import type { KeyEvent } from "@opentui/core";
import { Effect, Predicate } from "effect";
import { userError } from "../errors.js";

/** The Commands the terminal names itself, as an Extension names its own. */
export const terminalCommands: ReadonlyArray<{
  readonly name: string;
  readonly description: string;
}> = [
  { name: "quit", description: "Close the terminal" },
  { name: "new", description: "Start a new conversation in this directory" },
];

const starterKeys = [
  "enter: terminal.submit,",
  '"shift+enter": terminal.newline,',
  '"ctrl+j": terminal.newline,',
  "escape: terminal.interrupt,",
  '"ctrl+d": "/quit",',
];

/** The import of the terminal's options, as a Configuration writes it. */
export const terminalImport = 'import { terminal } from "@mitome/core/terminal";';

/** A `provide` entry with the starter keys, each line after `indent`. */
export const starterProvide = (indent: string): string =>
  ["provide: terminal({", "  keys: {", ...starterKeys.map((line) => `    ${line}`), "  },", "}),"]
    .map((line) => `${indent}${line}`)
    .join("\n");

/**
 * The key the base layout has where the terminal reports a non-Latin `name`, as a Latin letter or a
 * digit, when it reports one: OpenTUI's own key-binding lookup falls back to it in the same cases.
 */
const baseLayoutName = (name: string, baseCode: number | undefined): string | undefined => {
  if (baseCode === undefined || baseCode <= 32 || baseCode === 127) {
    return undefined;
  }
  const digitCode = baseCode >= 48 && baseCode <= 57;
  if (!/^\P{ASCII}$/u.test(name) && !digitCode) {
    return undefined;
  }
  const base = String.fromCodePoint(baseCode).toLowerCase();
  return /^[a-z0-9]$/.test(base) ? base : undefined;
};

/**
 * The names `+`-notation gives a key the terminal reports, to look its binding up by in order: the
 * key as reported, then the base layout's Latin key, so `ctrl+j` works on any layout. None for a
 * key no binding names.
 */
export const keysOf = (key: KeyEvent): ReadonlyArray<string> => {
  if (key.super === true || key.hyper === true) {
    return [];
  }
  // Without the enhanced keyboard protocol Ctrl+J arrives as a line feed, with it as Ctrl and J.
  const linefeed = key.name === "linefeed";
  const name = linefeed
    ? "j"
    : key.name === "return" || key.name === "kpenter"
      ? "enter"
      : key.name.toLowerCase();
  const modifiers = [
    key.ctrl || linefeed ? "ctrl" : "",
    key.meta ? "alt" : "",
    key.shift ? "shift" : "",
  ].filter((part) => part !== "");
  const base = baseLayoutName(key.name, key.baseCode);
  return [name, ...(base === undefined || base === name ? [] : [base])].map((each) =>
    [...modifiers, each].join("+"),
  );
};

const letter = /^[a-z]$/;
const digit = /^[0-9]$/;

/** Why the terminal does not bind `key`, if it does not: the terminal keeps it, or it types text. */
const refusal = (key: string): string | undefined => {
  const parts = key.split("+");
  const name = parts.at(-1) ?? "";
  if (key === "ctrl+c") {
    return "it always closes the terminal";
  }
  if (key === "tab") {
    return "it always moves between an Approval and the input";
  }
  if (
    (letter.test(name) || digit.test(name) || name === "space") &&
    !parts.includes("ctrl") &&
    !parts.includes("alt")
  ) {
    return "it types text; add ctrl or alt to it";
  }
  return undefined;
};

/**
 * The keys the terminal binds, from the options the Configuration at `path` provides, checked:
 * they exist, one sends the input, and none is a key the terminal keeps or one that types text.
 * Fails with what to change.
 */
export const terminalKeys = Effect.fnUntraced(function* (
  options: Options | undefined,
  path: string,
) {
  if (options === undefined) {
    return yield* userError(
      [
        `The terminal has no keys: ${path} does not provide its options. Add these lines to it:`,
        `  ${terminalImport}`,
        `${starterProvide("  ")}  // in Mitome.make({ ... }); with other services, provide: [terminal({ ... }), ...]`,
      ].join("\n"),
    );
  }
  const keys = new Map<string, Binding>(Object.entries(options.keys));
  for (const key of keys.keys()) {
    const reason = refusal(key);
    if (reason !== undefined) {
      return yield* userError(`Key "${key}" in ${path} cannot be bound: ${reason}.`);
    }
  }
  if (![...keys.values()].some((binding) => isControl(binding, terminal.submit))) {
    return yield* userError(
      `No key sends the input: bind one to terminal.submit in the terminal({ keys }) that ${path} provides, for example:\n  enter: terminal.submit,`,
    );
  }
  return keys;
});

/**
 * Whether `binding` is `control`, compared by id: the Configuration's copy of `@mitome/core`
 * made it, not the one in this binary.
 */
export const isControl = (binding: Binding, control: Control): boolean =>
  !Predicate.isString(binding) && binding.id === control.id;
