# Plan: the Extension shape, Commands and terminal keys

The decisions are [ADR-0067](../adr/0067-build-an-extension-from-a-record-or-an-effect.md) and [ADR-0068](../adr/0068-let-an-extension-name-its-commands.md). This is the order they are built in and where each change lands in the stack.

## Phase 1: the shape of the interface

| Change                                                                                                                                                          | Where                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `Provider.make(id, { modelIds, credential, provision, models })`                                                                                                | the kernel pull request, and the four first-party Providers   |
| `Extension.make(name, record)` and `Extension.make(name, Effect<record>)`; the setup runs once per Session; `layer` and handlers built by an Effect are removed | the Agent pull request                                        |
| `Mitome.make`'s `layer` becomes `provide` and accepts one Layer or a list                                                                                       | the Agent pull request, then every place that names the field |

Done when the Extension tests cover both forms, a wrong handler parameter and a missing Tool fail to compile, and Instructions keep `use` order whatever the timing of the setups.

## Phase 2: Commands and keys

| Change                                                                                                                                                         | Where                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `Command.make(name, { description, run })`, `Command.reply`, `Command.prompt`; an Extension's `commands`; a Session lists its Commands and runs one by name    | the Agent pull request                     |
| The `@mitome/core/terminal` subpath: `terminal({ keys })` and the controls `terminal.submit`, `terminal.newline`, `terminal.interrupt`                         | a new pull request at the top of the stack |
| The terminal reads its keys, lists Commands as `/` is typed, runs them, and has `/quit` and `/new` of its own; it refuses to open while no key sends the input | a new pull request at the top of the stack |
| `mitome init` writes the starter keys; the development Configuration provides them                                                                             | the same new pull request                  |
| The docs pages for Agents and the command line                                                                                                                 | the same new pull request                  |

Done when a Command typed in the terminal shows its reply or starts its Turn, an unknown one is refused without a Model request, a key bound to text behaves as that text typed and sent, and a Configuration with no key for sending the input is told which line to add.

## Later

A terminal interface service, a service for a run's events, an Extension listed in one Host's options, removing or renaming one Tool or Command where an Extension is listed, Commands in `mitome run`, and an Effect for `Agent.make`.
