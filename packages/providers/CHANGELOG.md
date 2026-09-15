# @mitome/providers

## 0.1.0

### Minor Changes

- 88ea7c0: The `@mitome/sdk` and `@mitome/sdk/extensions` APIs no longer expose Effect types. Import Effect-native Session and Transcript APIs from `@mitome/sdk/effect`, and Host or Provider authoring APIs from `@mitome/core`.

  SDK `TranscriptStore` methods now return Promises. `load` returns `null` for an unknown id, and rejected operations become `StoreError`s. Promise-only users no longer need to install Effect, while Effect users must match the exact version pinned by Mitome.

  Core now exports `CompiledTool`, `ToolInput`, `ToolOutput`, and `Json`. `@mitome/providers/openai-compatible` now exports `knownModelIds` and `KnownModelId`.

### Patch Changes

- 5793ee2: Codex authentication now reuses valid stored credentials and avoids redundant refreshes when several processes run at once or another process rotates a credential after a `401` response.
- 19ae752: Published libraries now declare themselves side-effect free, allowing bundlers to remove unused exports.
- Updated dependencies [8f26dc1]
- Updated dependencies [88ea7c0]
- Updated dependencies [9c47617]
- Updated dependencies [599c0fe]
- Updated dependencies [4e45a1f]
- Updated dependencies [bda85a3]
- Updated dependencies [eb4d90c]
- Updated dependencies [19ae752]
- Updated dependencies [ac80885]
  - @mitome/core@0.1.0
