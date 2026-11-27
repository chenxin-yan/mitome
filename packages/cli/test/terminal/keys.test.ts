// The terminal's key notation against what OpenTUI's own parser reports for real key sequences.
import { describe, expect, it } from "@effect/vitest";
import { terminal } from "@mitome/core/terminal";
import { KeyEvent, parseKeypress } from "@opentui/core";
import { Effect, Exit } from "effect";
import { keysOf, terminalKeys } from "../../src/terminal/keys.ts";

/** Every name a binding is looked up by for one key sequence, in order. */
const names = (sequence: string, useKittyKeyboard = false) => {
  const key = parseKeypress(sequence, { useKittyKeyboard });
  if (key === null) {
    throw new Error(`OpenTUI parsed no key from ${JSON.stringify(sequence)}`);
  }
  return keysOf(new KeyEvent(key));
};

/** The name a binding is looked up by first. */
const reported = (sequence: string, useKittyKeyboard = false) =>
  names(sequence, useKittyKeyboard)[0];

/** Why `key` is refused when bound to newline beside a key that sends, or `undefined`. */
const refused = (key: string) => {
  const exit = Effect.runSyncExit(
    terminalKeys({ keys: { "ctrl+s": terminal.submit, [key]: terminal.newline } }, "index.ts"),
  );
  return Exit.isSuccess(exit) ? undefined : String(exit.cause);
};

describe("keysOf", () => {
  it("names keys as the notation writes them, without the enhanced keyboard protocol", () => {
    expect(reported("\r")).toBe("enter");
    expect(reported("\u001b\r")).toBe("alt+enter");
    expect(reported("\u001b")).toBe("escape");
    expect(reported("\u0004")).toBe("ctrl+d");
    expect(reported("\u001bd")).toBe("alt+d");
    expect(reported("\u001bD")).toBe("alt+shift+d");
    expect(reported("\u001b\u0004")).toBe("ctrl+alt+d");
    expect(reported("\u001b[1;5A")).toBe("ctrl+up");
    expect(reported("\u001b[15;2~")).toBe("shift+f5");
    expect(reported("\u001b[Z")).toBe("shift+tab");
    expect(reported("\u0000")).toBe("ctrl+space");
  });

  it("names Ctrl+J ctrl+j both as a line feed and as the protocol reports it", () => {
    expect(reported("\n")).toBe("ctrl+j");
    expect(reported("\u001b[106;5u", true)).toBe("ctrl+j");
  });

  it("names keys the protocol tells apart", () => {
    expect(reported("\u001b[13;2u", true)).toBe("shift+enter");
    expect(reported("\u001b[100;3u", true)).toBe("alt+d");
    expect(reported("\u001b[100;6u", true)).toBe("ctrl+shift+d");
  });

  it("names a key on another layout also by its base layout's Latin key", () => {
    // Ctrl+J on a Cyrillic layout: the layout's letter о (1086), and J (106) as its base key.
    expect(names("\u001b[1086::106;5u", true)).toEqual(["ctrl+о", "ctrl+j"]);
    expect(names("\u001b[106;5u", true)).toEqual(["ctrl+j"]);
    expect(names("\n")).toEqual(["ctrl+j"]);
    // A base key that is neither a Latin letter nor a digit is not looked up.
    expect(names("\u001b[1102::46;5u", true)).toEqual(["ctrl+ю"]);
  });

  it("names no key for Super", () => {
    expect(reported("\u001b[100;9u", true)).toBeUndefined();
  });
});

describe("terminalKeys", () => {
  it("binds the starter keys", () => {
    const keys = Effect.runSync(
      terminalKeys(
        {
          keys: {
            enter: terminal.submit,
            "shift+enter": terminal.newline,
            "ctrl+j": terminal.newline,
            escape: terminal.interrupt,
            "ctrl+d": "/quit",
          },
        },
        "index.ts",
      ),
    );
    expect([...keys.keys()]).toEqual(["enter", "shift+enter", "ctrl+j", "escape", "ctrl+d"]);
  });

  it("refuses the keys that stay fixed and the keys that type text", () => {
    expect(refused("ctrl+c")).toContain(
      'Key "ctrl+c" in index.ts cannot be bound: it always closes the terminal.',
    );
    expect(refused("tab")).toContain(
      'Key "tab" in index.ts cannot be bound: it always moves between an Approval and the input.',
    );
    for (const key of ["a", "shift+a", "7", "shift+7", "space", "shift+space"]) {
      expect(refused(key), key).toContain(
        `Key "${key}" in index.ts cannot be bound: it types text; add ctrl or alt to it.`,
      );
    }
  });

  it("binds every other key, those that need the enhanced keyboard protocol included", () => {
    for (const key of [
      "shift+enter",
      "ctrl+enter",
      "ctrl+i",
      "ctrl+m",
      "ctrl+h",
      "ctrl+shift+d",
      "shift+escape",
      "ctrl+tab",
      "ctrl+5",
      "ctrl+j",
      "alt+enter",
      "escape",
      "alt+escape",
      "shift+tab",
      "alt+tab",
      "ctrl+space",
      "ctrl+d",
      "ctrl+alt+d",
      "alt+shift+d",
      "alt+5",
      "backspace",
      "ctrl+up",
      "ctrl+alt+shift+f12",
      "shift+pagedown",
      "delete",
    ]) {
      expect(refused(key), key).toBeUndefined();
    }
  });

  it("refuses to open without options, and without a key that sends", () => {
    const missing = Effect.runSyncExit(terminalKeys(undefined, "/home/me/index.ts"));
    expect(String(Exit.isFailure(missing) && missing.cause)).toContain(
      [
        "The terminal has no keys: /home/me/index.ts does not provide its options. Add these lines to it:",
        '  import { terminal } from "@mitome/core/terminal";',
        "  provide: terminal({",
        "    keys: {",
        "      enter: terminal.submit,",
        '      "shift+enter": terminal.newline,',
        '      "ctrl+j": terminal.newline,',
        "      escape: terminal.interrupt,",
        '      "ctrl+d": "/quit",',
        "    },",
        "  }),  // in Mitome.make({ ... }); with other services, provide: [terminal({ ... }), ...]",
      ].join("\n"),
    );
    const unsent = Effect.runSyncExit(
      terminalKeys({ keys: { "ctrl+j": terminal.newline } }, "index.ts"),
    );
    expect(String(Exit.isFailure(unsent) && unsent.cause)).toContain(
      "No key sends the input: bind one to terminal.submit in the terminal({ keys }) that index.ts provides, for example:\n  enter: terminal.submit,",
    );
  });
});
