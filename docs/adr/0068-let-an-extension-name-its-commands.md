---
status: accepted
---

# Let an Extension name its Commands, and bind keys in the terminal's options

A Tool is something the Model calls. A Command is something a person invokes, by typing `/name` at the start of an input. An Extension lists its Commands beside its Tools, and each carries its own name:

```ts
commands: [
  Command.make("todos", {
    description: "Show the todo list",
    run: () => Effect.map(Ref.get(todos), (list) => Command.reply(render(list))),
  }),
  Command.make("plan", {
    description: "Plan the work",
    run: (input) => Effect.succeed(Command.prompt(`Plan this: ${input}`)),
  }),
],
```

Listing the Extension in the Agent's `use` turns its Commands on, as it does its Tools. Nothing else names or enables them, so a feature arrives and leaves in one place, and every Host that runs the Agent offers the same Commands. Two Commands with one name are refused, naming both Extensions, which is the rule for two Tools: when the Agent is built if both come from records, and when the Session starts if a setup returned one of them.

A Command takes the text after its name and returns what the Host should do next: show text to the person (`Command.reply`), or start a Turn with an input (`Command.prompt`). It runs with what its Extension's setup holds ([ADR-0067](0067-build-an-extension-from-a-record-or-an-effect.md)). It receives no Session, screen or editor, so it cannot deadlock a Turn or keep a stale handle, and it works wherever a person can type. These two results are the whole set: more power comes later through services a Command asks for, never through more kinds of result, which would grow into a second way to drive a Session.

The core does the shared part once. A Session lists its Commands and runs one by name; an unknown name is an error shown to the person, and nothing reaches the Model. Only an input whose first character is `/`, followed by a name and then whitespace or the end, is a Command. A name is lowercase letters, digits and underscores, starts with a letter and is at most 31 characters, and a description is one line of at most 100, which are the strictest limits of the chat platforms a Channel may one day serve. The kernel that runs Turns and Steps knows nothing of Commands: only a Host invokes one, and where no person is present they are inert.

Keys belong to the terminal, because only a terminal has them. A Configuration provides the terminal's options, and a key is bound either to one of the terminal's controls or to text the terminal types:

```ts
import { terminal } from "@mitome/core/terminal";

provide: [
  terminal({
    keys: {
      enter: terminal.submit,
      "shift+enter": terminal.newline,
      "ctrl+j": terminal.newline,
      escape: terminal.interrupt,
      "ctrl+d": "/quit",
      "ctrl+t": "/todos",
    },
  }),
],
```

So `"ctrl+t": "/todos"` means that pressing the key is the same as typing the text and sending it, and the text may carry an input. The terminal names its own Commands, `/quit` and `/new`, as an Extension names its own. Keys are written one way, lowercase with `+` between modifiers. A key that types text, and the keys the terminal keeps for itself (Ctrl+C, and Tab while an Approval is shown), are refused. A key that a terminal can tell from another only with the enhanced keyboard protocol is accepted, as other harnesses accept it: Shift+Enter makes a new line where the terminal reports it and arrives as Enter, and so sends, where it does not. The starter set therefore binds two keys to a new line, Shift+Enter and Ctrl+J, which every terminal reports. There are no default keys: `mitome init` writes the starter set into the person's own Configuration, and the terminal refuses to open while no key is bound to `terminal.submit` and says which line to add; the starter set binds Enter, which every terminal reports. Typing `/` lists the Commands, so there is no separate command for listing them.

The terminal's options are a subpath of the core package ([ADR-0061](0061-ship-one-package-and-gate-what-enters-its-core.md)): plain data with no outside dependency. They cannot come from `@mitome/cli`, which holds a compiled binary and no library code.

## Considered options

- **Names bound in the Configuration**, by a map or an item of their own. Every feature then needs a second step and lives in two places, and a Command could differ between Hosts. No tool surveyed makes the person name an extension's commands; the norm against binding automatically is about keys, which are scarce and collide.
- **Names in the terminal's options only.** Codex keeps its commands in its terminal; every tool with more than one surface (opencode, Claude Code, pi, Hermes) keeps portable commands below the interface.
- **A key bound to a Command by value.** A Command made in a setup has no value to point at before a Session starts. Binding the text a person would type needs no second notion, carries an input, and is checked when the terminal opens.
- **A Command that receives the Session and the screen**, as pi's does. pi documents the cost: calls that deadlock outside a command, and handles that go stale when the session is replaced.
- **Typed arguments.** One string is the only form every surface delivers; a schema can be added later without breaking a Command.
- **Default keys the terminal ships.** An upgrade would change bindings the person never wrote.
- **Refusing a key such as Shift+Enter because some terminals cannot tell it from Enter.** A Configuration would behave the same everywhere, at the price of refusing the key most people expect where it does work. Asking the terminal whether it supports the protocol, and saying so once when it does not, is possible later.
- **A `mitome commands` subcommand that lists every Command and key.** It answered a need of the earlier design, where a person bound each Command by hand and could not otherwise see what an Extension added.

The survey is in [commands-and-bindings.md](../research/commands-and-bindings.md).

## Consequences

This settles the "Host-side contributions such as commands" that [ADR-0058](0058-describe-an-agent-as-data-and-run-it-through-a-configuration.md) left open. `@mitome/core` gains a `terminal` subpath that the root entry never imports. A Configuration that opens the terminal must now provide its options; one written before this has none and is told what to add.

An Extension's update can add a Command the person did not choose, as it can a Tool. A Command typed while a Turn runs is refused. `mitome run` does not recognise Commands. Not yet possible: a Command that reads or changes the conversation (compacting it, browsing its tree), one that asks the person to choose or confirm, a new conversation started the same way on every Host, and what a Channel needs on top, such as a platform's menu of Commands and who may run which.
