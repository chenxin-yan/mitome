---
"@mitome/core": minor
"@mitome/providers": minor
---

Providers now carry each Model's context window as private metadata. `makeProvider` accepts an optional fifth argument, `models`, mapping Provider-native Model ids to `{ contextWindow }`; the public `Provider` value still exposes only `id` and `modelIds`. Core exports the `ModelMetadata` and `ModelMetadataMap` types.

`openai()` supplies the context windows models.dev reports for its known Model ids, and `openaiCompatible()` accepts a `models` option to declare them per endpoint-native Model id. Ids without an entry have no known window; Mitome never guesses one.
