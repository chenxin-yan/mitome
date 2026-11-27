import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TerminalOptions, terminal } from "../src/terminal.js";
import type * as TerminalModule from "../src/terminal.js";
import type { Options } from "../src/terminal.js";

/** The options a Layer of `terminal` provides, as the terminal reads them. */
const provided = (options: Options) =>
  Effect.runSync(
    Effect.map(TerminalOptions, (options) => options).pipe(Effect.provide(terminal(options))),
  );

describe("terminal", () => {
  it("provides its keys, absent by default", () => {
    expect(Effect.runSync(Effect.map(TerminalOptions, (options) => options))).toBeUndefined();
    const keys = {
      enter: terminal.submit,
      "ctrl+j": terminal.newline,
      escape: terminal.interrupt,
      "ctrl+d": "/quit",
      "ctrl+alt+shift+f12": "/plan the work",
    } as const;
    const options = provided({ keys });
    expect(options).toEqual({ keys });
    expect(Object.isFrozen(options) && Object.isFrozen(options?.keys)).toBe(true);
  });

  it("keeps a copy, so later changes to the record change nothing", () => {
    const keys = { enter: terminal.submit };
    const layer = terminal({ keys });
    Object.assign(keys, { "ctrl+d": "/quit" });
    expect(
      Effect.runSync(Effect.map(TerminalOptions, (options) => options).pipe(Effect.provide(layer)))
        ?.keys,
    ).toEqual({ enter: terminal.submit });
  });

  it("has frozen controls with distinct ids", () => {
    const controls = [terminal.submit, terminal.newline, terminal.interrupt];
    expect(controls.map((control) => control.id)).toEqual([
      "mitome/terminal/submit",
      "mitome/terminal/newline",
      "mitome/terminal/interrupt",
    ]);
    expect(controls.every((control) => Object.isFrozen(control))).toBe(true);
    expect(Object.isFrozen(terminal)).toBe(true);
  });

  it("recognises a control and finds options made by another copy of the module", async () => {
    // A query makes the module loader load the same file again as another module.
    const copy = "../src/terminal.ts?copy";
    // SAFETY: the same file, loaded a second time, as the CLI binary and a Configuration load it.
    const other = (await import(copy)) as typeof TerminalModule;
    expect(other.terminal.submit).not.toBe(terminal.submit);
    const layer = terminal({ keys: { enter: other.terminal.submit } });
    const options = Effect.runSync(
      Effect.map(other.TerminalOptions, (options) => options).pipe(Effect.provide(layer)),
    );
    expect(options?.keys).toEqual({ enter: { id: "mitome/terminal/submit" } });
  });

  it("refuses an unknown field, and keys that are not a record", () => {
    // SAFETY: deliberately mistyped, so the runtime check sees what the types would reject.
    expect(() => terminal({ keys: {}, theme: "dark" } as never)).toThrow(
      new TypeError('terminal has no field "theme"'),
    );
    // SAFETY: deliberately mistyped, so the runtime check sees what the types would reject.
    expect(() => terminal({} as never)).toThrow(
      new TypeError("terminal keys must be a record of keys and what each does"),
    );
    // SAFETY: deliberately mistyped, so the runtime check sees what the types would reject.
    expect(() => terminal({ keys: [] } as never)).toThrow(
      "terminal keys must be a record of keys and what each does",
    );
    // SAFETY: deliberately mistyped, so the runtime check sees what the types would reject.
    expect(() => terminal(undefined as never)).toThrow("terminal options must be a record");
  });

  it("refuses a value that is neither a control nor text starting with /", () => {
    for (const binding of ["quit", "", { id: "mitome/terminal/quit" }, { id: 1 }, 42, null]) {
      // SAFETY: deliberately mistyped, so the runtime check sees what the types would reject.
      expect(() => terminal({ keys: { "ctrl+d": binding as never } })).toThrow(
        new TypeError(
          'Key "ctrl+d" must be bound to terminal.submit, terminal.newline, terminal.interrupt or text starting with /',
        ),
      );
    }
  });

  it("refuses a key not written in the one notation", () => {
    for (const key of [
      "Ctrl+d",
      "ctrl-d",
      "shift+ctrl+d",
      "alt+ctrl+d",
      "ctrl+ctrl+d",
      "ctrl+",
      "ctrl",
      "return",
      "esc",
      "f13",
      "f0",
      "ctrl+/",
      "super+d",
      "meta+d",
      "D",
      " enter",
    ]) {
      expect(() => terminal({ keys: { [key]: terminal.submit } }), key).toThrow(
        new TypeError(
          `Key "${key}" must be written in lowercase as its modifiers ctrl, alt and shift, in that order, then one key name, joined by +, such as ctrl+d`,
        ),
      );
    }
  });

  it("accepts every key name with every ordered set of modifiers", () => {
    const names = [
      ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
      "enter",
      "escape",
      "tab",
      "space",
      "backspace",
      "delete",
      "up",
      "down",
      "left",
      "right",
      "home",
      "end",
      "pageup",
      "pagedown",
      ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
    ];
    const prefixes = ["", "ctrl+", "alt+", "shift+", "ctrl+alt+", "ctrl+shift+", "alt+shift+"];
    const keys = Object.fromEntries(
      [...prefixes, "ctrl+alt+shift+"].flatMap((prefix) =>
        names.map((name) => [`${prefix}${name}`, "/x"] as const),
      ),
    );
    expect(Object.keys(provided({ keys })?.keys ?? {})).toHaveLength(8 * names.length);
  });
});
