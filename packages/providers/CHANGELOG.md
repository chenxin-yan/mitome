# @mitome/providers

## 0.1.0

### Minor Changes

- 88ea7c0: Keep `@mitome/sdk` and `@mitome/sdk/extensions` signatures Effect-free with Mitome-owned model types. The SDK's `TranscriptStore` returns Promises: `load` returns `null` for an unknown id, mapped to `TranscriptNotFound`; rejections surface as `StoreError`.

  Import Effect-native Session and Transcript helpers from `@mitome/sdk/effect` instead of the SDK root, and Host/Provider authoring contracts from `@mitome/core`. Core also exports `CompiledTool`, `ToolInput`, `ToolOutput`, and `Json`; `@mitome/providers/openai-compatible` adds `knownModelIds` (empty) and `KnownModelId`.

  Pin Effect as an exact regular dependency rather than a peer. Promise-only users need no separate Effect installation; Effect-native consumers must match the pinned version.

### Patch Changes

- 19ae752: Annotate library builds with pure calls and declare `sideEffects: false` for consumer tree-shaking.
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
