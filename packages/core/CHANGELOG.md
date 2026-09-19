# @mitome/core

## 0.1.0

### Minor Changes

- 8f26dc1: Replace standalone `tool()` declarations with scoped builders in `defineAgent({ tools })` and `defineExtension({ tools })`. Tools may omit `outputSchema`, or declare `failureSchema` and return `ok()` or `fail()` for expected failures.

  Tool inputs are now validated and decoded once before hooks, approval checks, and handlers run. Invalid input returns an `execution-denied` result to the model, while validator defects fail the turn. SDK validation errors include every issue and available path.

  `postTool` hooks now receive expected failures with `isFailure: true`. End hooks run in reverse Agent Definition order, including cleanup after failed or interrupted starts. The SDK Extension `setup` callback no longer receives an `AbortSignal`.

- 88ea7c0: The `@mitome/sdk` and `@mitome/sdk/extensions` APIs no longer expose Effect types. Import Effect-native Session and Transcript APIs from `@mitome/sdk/effect`, and Host or Provider authoring APIs from `@mitome/core`.

  SDK `TranscriptStore` methods now return Promises. `load` returns `null` for an unknown id, and rejected operations become `StoreError`s. Promise-only users no longer need to install Effect, while Effect users must match the exact version pinned by Mitome.

  Core now exports `CompiledTool`, `ToolInput`, `ToolOutput`, and `Json`. `@mitome/providers/openai-compatible` now exports `knownModelIds` and `KnownModelId`.

- 9c47617: `Host` is now a union discriminated by `kind`. Add `kind: "interactive"` to terminal Hosts and `kind: "channel"` plus a unique `name` to Channel Hosts. `defineMitome({ agent, hosts })` accepts multiple Hosts; the CLI runs the first supported interactive Host, and installing `@mitome/tui` does not activate it until `tui()` is registered.

  Add `mitome serve` to run every registered Channel Host. `handle` Hosts share one listener under `/<name>` using `--port` or port 3000, while `serve` Hosts receive an `AbortSignal`. Core also exports `Routes`, `memoryRoutes()`, and `fileRoutes()` for mapping channel routes to Transcripts.

- 599c0fe: `defineAgent` now accepts an `approvals` policy with `allow`, `ask`, and `deny` Tool-name patterns or a decision callback. The strictest Agent or Extension decision wins, and Agent `allow` bypasses the Tool's own approval predicate. Failed predicates require Host approval instead of running the Tool.

  The TUI prompts for required approvals with `y`, `n`, or `a` to allow a Tool-requested approval for the current Session. Non-interactive runs deny requests by default; pass `--yes` to approve Tool-requested prompts for one invocation. Policy and predicate-error requests are never approved by `--yes`.

- 552f6e0: Providers now carry each Model's context window as private metadata. `makeProvider` accepts an optional fifth argument, `models`, mapping Provider-native Model ids to `{ contextWindow }`; the public `Provider` value still exposes only `id` and `modelIds`. Core exports the `ModelMetadata` and `ModelMetadataMap` types.

  `openai()` supplies the context windows models.dev reports for its known Model ids, and `openaiCompatible()` accepts a `models` option to declare them per endpoint-native Model id. Ids without an entry have no known window; Mitome never guesses one.

- 4e45a1f: Agent `extensions` and SDK Extension `tools` are now optional and default to empty arrays. `withSession` is now callback-last: use `withSession(agent, options, use)` or `withSession(agent, use)`.
- bda85a3: Remove Extension dependency injection through `dependencies`, `provides`, and `getService`; compose Extensions in Agent Definition order instead. Extension names are now optional. Reusing one Extension object contributes it once, while different Extensions with the same name are rejected.
- eb4d90c: Rename `Session.prompt` to `Session.runTurn` and `PromptOptions` to `TurnOptions`. Host authors now read the staged Message from `HostContext.message` instead of `HostContext.prompt`.

### Patch Changes

- 19ae752: Published libraries now declare themselves side-effect free, allowing bundlers to remove unused exports.
- ac80885: Add versioned `TranscriptSchema` plus `makeTranscript` and `promptFromTranscript` in `@mitome/core` and `@mitome/sdk/effect`. Sessions can start from a Transcript and expose committed snapshots through `session.transcript()`; configure persistence with `fileTranscripts()`, `memoryTranscripts()`, or a custom `TranscriptStore`. Turn event records cannot seed a Session.

  A failed Transcript save no longer adds the turn to `history()`, `transcript()`, or TUI history. Non-JSON Tool results other than top-level `undefined` now reach the model unchanged and fail Transcript saving with `SchemaError`; write-only event records still use `null`. Disk-backed Transcript and Route stores also remove temporary files after failed writes.
