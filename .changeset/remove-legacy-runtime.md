---
"@mitome/core": minor
"@mitome/cli": minor
"create-mitome": minor
---

Remove the legacy runtime without a compatibility surface. `@mitome/core` no longer exports Agent Definitions, Extensions and Hooks, `defineMitome` and its Host types, Routes, Transcripts and Transcript stores, Turn events, `TurnError` or `ApprovalResolutionError`; it exports native Sessions, Turns, controlled Steps and Providers. `@mitome/sdk`, `@mitome/channels` and `@mitome/tui` are no longer published.

The `mitome` CLI now provides only `--help` and `--version`; its Definition-driven run, `serve`, `init`, `auth`, `install`, `add`, `remove` and `ext` commands are removed. `create-mitome` scaffolds an Effect program that runs `loop` in a Turn of a `makeSession` Session with a `providerModel` binding, and no longer offers a Promise template.
