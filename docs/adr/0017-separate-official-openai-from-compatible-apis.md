# Separate official OpenAI from OpenAI-compatible APIs

`@mitome/openai` uses `@effect/ai-openai` and OpenAI's Responses API, while `@mitome/openai-compatible` uses `@effect/ai-openai-compat` and the OpenAI-compatible Chat Completions protocol. A Definition selects the transport explicitly through its imported factory; Mitome does not infer it from a model identifier or URL, probe endpoints, or fall back between protocols.

Both packages remain thin adapters returning Core's opaque Model. The official package may accept an alternate Responses API root for controlled endpoints and proxies; the compatible package requires an explicit API root and accepts arbitrary model identifiers because compatible providers have no shared model catalog.
