---
"@mitome/core": patch
"@mitome/sdk": patch
---

Add versioned `TranscriptSchema` and `makeTranscript` / `promptFromTranscript` conversion APIs in `@mitome/core` and `@mitome/sdk/effect` for committed Session messages. Compose persistence explicitly with a `TranscriptStore`, using `fileTranscripts()` or `memoryTranscripts()`, through `defineMitome({ transcripts })` or Session options. Sessions support Transcript seeding/resume and `session.transcript()` snapshots; Turn event records are write-only observability data, not a replay source.
