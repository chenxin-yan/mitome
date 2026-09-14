---
"@mitome/core": patch
"@mitome/sdk": patch
"@mitome/tui": patch
---

Add versioned `TranscriptSchema` plus `makeTranscript` and `promptFromTranscript` in `@mitome/core` and `@mitome/sdk/effect`. Sessions can start from a Transcript and expose committed snapshots through `session.transcript()`; configure persistence with `fileTranscripts()`, `memoryTranscripts()`, or a custom `TranscriptStore`. Turn event records cannot seed a Session.

A failed Transcript save no longer adds the turn to `history()`, `transcript()`, or TUI history. Non-JSON Tool results other than top-level `undefined` now reach the model unchanged and fail Transcript saving with `SchemaError`; write-only event records still use `null`. Disk-backed Transcript and Route stores also remove temporary files after failed writes.
