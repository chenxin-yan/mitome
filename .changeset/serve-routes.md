---
"@mitome/core": minor
"@mitome/cli": minor
---

Add `mitome serve`, the long-lived role that runs every Channel Host of a Mitome Definition: `handle` is mounted under `/<name>` on one listener (`--port`, default 3000) with the prefix stripped, `serve` runs with an `AbortSignal`, and `SIGINT`/`SIGTERM` shut everything down. A Channel whose `serve` throws at startup exits non-zero naming it; one that fails at runtime is logged while the others keep running; a Definition without Channel Hosts is refused. `@mitome/core` gains the Effect-native `Routes` contract, `(channel, principal, conversation) → latest TranscriptId`, with `memoryRoutes()` and `fileRoutes()` beside the Transcript adapters; Channels take a Route store through their own factory options.
