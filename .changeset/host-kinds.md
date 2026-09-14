---
"@mitome/core": minor
"@mitome/sdk": minor
"@mitome/tui": minor
"@mitome/cli": minor
---

`Host` is now a union discriminated by `kind`. Add `kind: "interactive"` to terminal Hosts and `kind: "channel"` plus a unique `name` to Channel Hosts. `defineMitome({ agent, hosts })` accepts multiple Hosts; the CLI runs the first supported interactive Host, and installing `@mitome/tui` does not activate it until `tui()` is registered.

Add `mitome serve` to run every registered Channel Host. `handle` Hosts share one listener under `/<name>` using `--port` or port 3000, while `serve` Hosts receive an `AbortSignal`. Core also exports `Routes`, `memoryRoutes()`, and `fileRoutes()` for mapping channel routes to Transcripts.
