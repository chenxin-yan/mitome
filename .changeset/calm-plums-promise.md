---
"@mitome/core": minor
"@mitome/sdk": minor
"@mitome/providers": minor
"@mitome/tui": minor
---

Keep `@mitome/sdk` and `@mitome/sdk/extensions` signatures Effect-free with Mitome-owned model types. The SDK's `TranscriptStore` returns Promises: `load` returns `null` for an unknown id, mapped to `TranscriptNotFound`; rejections surface as `StoreError`.

Import Effect-native Session and Transcript helpers from `@mitome/sdk/effect` instead of the SDK root, and Host/Provider authoring contracts from `@mitome/core`. Core also exports `CompiledTool`, `ToolInput`, `ToolOutput`, and `Json`; `@mitome/providers/openai-compatible` adds `knownModelIds` (empty) and `KnownModelId`.

Pin Effect as an exact regular dependency rather than a peer. Promise-only users need no separate Effect installation; Effect-native consumers must match the pinned version.
