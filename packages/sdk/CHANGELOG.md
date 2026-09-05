# @mitome/sdk

## 0.1.0

### Minor Changes

- 8f26dc1: Replace standalone `tool()` declarations with scoped builders in `defineAgent({ tools })` and `defineExtension({ tools })`. Omit `outputSchema` to infer unvalidated outputs, or declare `failureSchema` and return `ok()` / `fail()` for schema-checked expected failures visible to the Model; thrown errors remain opaque.
- 88ea7c0: Keep `@mitome/sdk` and `@mitome/sdk/extensions` signatures Effect-free with Mitome-owned model types. The SDK's `TranscriptStore` returns Promises: `load` returns `null` for an unknown id, mapped to `TranscriptNotFound`; rejections surface as `StoreError`.

  Import Effect-native Session and Transcript helpers from `@mitome/sdk/effect` instead of the SDK root, and Host/Provider authoring contracts from `@mitome/core`. Core also exports `CompiledTool`, `ToolInput`, `ToolOutput`, and `Json`; `@mitome/providers/openai-compatible` adds `knownModelIds` (empty) and `KnownModelId`.

  Pin Effect as an exact regular dependency rather than a peer. Promise-only users need no separate Effect installation; Effect-native consumers must match the pinned version.

- d47566c: Add explicit `defineMitome({ agent, hosts })` composition with optional `hosts` and at most one Host. In automatic mode, the CLI runs the declared Host when supported and otherwise falls back to one-shot output. Declare `tui()` from `@mitome/tui` to enable the interactive Host; installing the package alone does not activate it.
- 4e45a1f: Make Agent Definition `extensions` and SDK Extension `tools` optional with empty defaults. Move `withSession` options before its callback: use `withSession(agent, options, use)` or `withSession(agent, use)`.
- bda85a3: Remove Extension dependency injection (`dependencies`, `provides`, and `getService`); compose Extensions explicitly in Agent Definition order and keep Resources private to their owning Extension. Extension names are optional: repeating the same object contributes it once, separate anonymous values remain distinct, and different values sharing a name fail compilation.
- eb4d90c: Rename `Session.prompt` to `Session.runTurn` and `PromptOptions` to `TurnOptions`. Host authors receive the staged Message through `HostContext.message` instead of `HostContext.prompt`.

### Patch Changes

- 4fa24f2: Tool input validation failures return an `execution-denied` result to the Model before `preTool`, approval, or the handler runs, with reason `Tool input validation failed: <issues>`. The Turn continues; validator defects instead fail it with `TurnError`.
- 9f37ce9: Report distinct CLI authentication errors for unavailable OAuth Providers, capability modules missing `authenticate`, and invalid authentication operations or configuration. SDK schema validation reports every issue with its available path. Failed `needsApproval` predicates log a warning and require approval rather than allowing the Tool to run automatically.
- 423b70a: Run `postTool` Hooks for failed handler results with `isFailure: true`. Hooks may transform expected failures, which are checked by the failure validator; handler defects remain opaque, and the success-result validator sees only successful outputs. The SDK Extension `setup` callback no longer receives an `AbortSignal`, since Resource acquisition is uninterruptible.
- c6e5f4b: Run end Hooks (`sessionEnd`, `turnEnd`, `stepEnd`) in reverse Agent Definition order, including cleanup after interrupted or failed starts. Commit a Turn to `history()` and `transcript()` only after the configured Transcript save succeeds; a failed save leaves it out of both.
- 19ae752: Annotate library builds with pure calls and declare `sideEffects: false` for consumer tree-shaking.
- ac80885: Add versioned `TranscriptSchema` and `makeTranscript` / `promptFromTranscript` conversion APIs in `@mitome/core` and `@mitome/sdk/effect` for committed Session messages. Compose persistence explicitly with a `TranscriptStore`, using `fileTranscripts()` or `memoryTranscripts()`, through `defineMitome({ transcripts })` or Session options. Sessions support Transcript seeding/resume and `session.transcript()` snapshots; Turn event records are write-only observability data, not a replay source.
- Updated dependencies [8f26dc1]
- Updated dependencies [88ea7c0]
- Updated dependencies [d47566c]
- Updated dependencies [4fa24f2]
- Updated dependencies [9f37ce9]
- Updated dependencies [4e45a1f]
- Updated dependencies [423b70a]
- Updated dependencies [bda85a3]
- Updated dependencies [eb4d90c]
- Updated dependencies [c6e5f4b]
- Updated dependencies [19ae752]
- Updated dependencies [ac80885]
  - @mitome/core@0.1.0
