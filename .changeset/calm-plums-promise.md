---
"@mitome/core": minor
"@mitome/sdk": minor
"@mitome/providers": minor
"@mitome/tui": minor
---

The `@mitome/sdk` and `@mitome/sdk/extensions` APIs no longer expose Effect types. Import Effect-native Session and Transcript APIs from `@mitome/sdk/effect`, and Host or Provider authoring APIs from `@mitome/core`.

SDK `TranscriptStore` methods now return Promises. `load` returns `null` for an unknown id, and rejected operations become `StoreError`s. Promise-only users no longer need to install Effect, while Effect users must match the exact version pinned by Mitome.

Core now exports `CompiledTool`, `ToolInput`, `ToolOutput`, and `Json`. `@mitome/providers/openai-compatible` now exports `knownModelIds` and `KnownModelId`.
