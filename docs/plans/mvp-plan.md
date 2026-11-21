# MVP plan

Agreed with the owner 2026-11-17 and reshaped 2026-11-21. It lands the Effect-native library and CLI in the shape of [ADR-0058](../adr/0058-describe-an-agent-as-data-and-run-it-through-a-configuration.md) to [ADR-0061](../adr/0061-ship-one-package-and-gate-what-enters-its-core.md) as one stack of pull requests from `main`.

A first native stack (#205, #207, #211, #213, #214) was reviewed and passed its checks, then closed unmerged when the design was revisited. Its code and review fixes are carried into this stack; its `defineMitome`, `--app` and application-owned Approval channel are not.

## Goal

Run an Agent from a library, from `mitome run` and from a terminal, in one process. History stays in memory unless the Configuration adds a store ([ADR-0066](../adr/0066-keep-history-as-a-tree-of-steps.md)); nothing is streamed or served yet.

The stack tip is a merge milestone, not a public release. The release gates of the [library plan](effect-native-library.md) still stand (durable recovery among them), and nothing is published from it.

## Done means

All of these work at the stack tip, each covered by a test:

- A Configuration of three files (an Agent, a Configuration, one own Extension with a Tool that needs Approval) loads from `~/.config/mitome` or `--config`.
- `mitome` opens the terminal with it; the Approval is answered with `y` or `n`.
- `mitome run "…"` with the same Configuration denies the Approval, tells the Model, and exits instead of waiting.
- The same Agent runs from a test with `Session.make(agent)` and a scripted Model, with no Configuration and no Host.
- `mitome init` writes a Configuration that `mitome` loads.
- `npm create mitome` writes an application that embeds an Agent and runs.
- Build, check and test gates pass on every pull request.

## The stack

| #   | Pull request                              | What it brings                                                                                                                                                                                       | Carried over or new                                                      |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Design records                            | The decision records, glossary, design plan and research. No code.                                                                                                                                   | #205 and #207, plus ADR-0058 to ADR-0062                                 |
| 2   | Remove the legacy runtime                 | Deletes the Promise SDK, Channels and the old CLI, terminal and docs pages; moves the workspace to Effect 4.1.6                                                                                      | The deletions and pins of #211                                           |
| 3   | `@mitome/core`: Sessions, Turns and Steps | The `@mitome/core` package with `session/`: `Session.make`, the Turn, the Step and loop, Tool gating, limits, `Provider.make`, and the approver the gate asks, which denies by default               | Carried from #211; the names and the approver are new                    |
| 4   | `@mitome/core`: Agent and Configuration   | `agent/`: `Agent.make` (optional `program`, `text` mapping), `Extension.make` (a record, or an Effect that returns one), Commands, `Mitome.make`; a lint rule that `session/` never imports `agent/` | New, replacing `defineMitome`                                            |
| 5   | Providers                                 | OpenAI, OpenAI-compatible and Codex                                                                                                                                                                  | Carried from #211                                                        |
| 6   | Anthropic Provider                        | A binding over `@effect/ai-anthropic` 4.1.6                                                                                                                                                          | New                                                                      |
| 7   | CLI: load a Configuration and run it      | `mitome run`, `--config`, the default config directory, the login commands, credentials in the state directory, the platform binaries                                                                | Carried from #213; the selector, default and credential location are new |
| 8   | Terminal Host                             | Bare `mitome` opens the terminal, which answers Approvals                                                                                                                                            | Carried from #214; the approver wiring is new                            |
| 9   | Scaffold                                  | `npm create mitome` writes an application that embeds an Agent as a library, and exports the template pieces `mitome init` shares                                                                    | Carried from #211, rewritten for the new API                             |
| 10  | `mitome init`                             | Writes the default Configuration (`agent.ts`, `index.ts`, `package.json`) into the config directory and installs its dependencies                                                                    | New                                                                      |
| 11  | Docs site                                 | The docs pages and READMEs for Agents, Configurations, applications and the CLI                                                                                                                      | Carried from #211 to #214, rewritten for the new API                     |
| 12  | Anthropic Console sign-in                 | The Anthropic Provider also accepts the profile that Anthropic's `ant auth login` writes ([ADR-0063](../adr/0063-sign-in-to-anthropic-through-the-console-profile.md))                               | New                                                                      |

Each pull request builds on the one before it and passes the gates alone. The stack merges bottom-up as one unit, with merge commits.

Further pull requests follow these twelve on the same stack: the move to pnpm and Vite+ (ADR-0064, which that pull request adds), a store that keeps conversations in files ([ADR-0066](../adr/0066-keep-history-as-a-tree-of-steps.md)), and Commands with the terminal's keys ([ADR-0068](../adr/0068-let-an-extension-name-its-commands.md)). Until that last one, the terminal's keys are fixed and it runs no Commands.

## Tooling

Carried from the first stack because the code needs it: the Effect and Vitest pins, the workspace list, the model-hint script input, the release fixtures and the all-platform install in the release workflow (the terminal's native package). New: the `session/` and `agent/` import rule.

Left out: `tools/qualification/` and the two SQLite packages it used. They are evidence for the Effect baseline and for a store this plan does not build; the first stack's branches keep them.

## Not in the MVP

Each of these is decided in the records above, or still to be designed, and comes after.

- Streaming output and the event list ([ADR-0062](../adr/0062-stream-for-display-only.md)).
- The `context` and `events` fields on an Extension (they need support in the Step that streaming also needs).
- The interaction service (`ask`, `notify`) and the Session-long Approval grant.
- Syncing dependencies before running. Until then a missing install prints the exact command.
- Recovery of a Turn that was running when the process stopped, Compaction, and navigating the History tree from the terminal. Saved history, continuing a conversation and branching are in ([ADR-0066](../adr/0066-keep-history-as-a-tree-of-steps.md)).
- Commands in `mitome run`, a Command that reads or changes the conversation, queued Messages, `mitome serve`, Channels, schedules, Delegation.
- First-party Extensions: coding Tools, Skills, MCP, web.

After the MVP, the shortest path to using it as a coding agent is streaming, then coding Tools.

## Risks

- npm refuses to register the unscoped name `mitome` as too similar to `mime` (2026-11-21). A review is requested. The package is published as `@mitome/core` meanwhile and switches to `mitome` when npm allows that name.
- Pull request 4 sets the types that the CLI, the terminal and the scaffold all use; 7 to 9 cannot start before it.
- Work a finalizer forks into the closing Turn Scope with `Effect.forkScoped` never starts, because that Scope is already closed; children a finalizer forks as fibers are awaited.
