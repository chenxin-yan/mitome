---
"@mitome/providers": minor
---

Add `@mitome/providers/anthropic`: `anthropic({ apiKeyEnv, baseUrl })` is an Anthropic Messages API Provider over `@effect/ai-anthropic`, authenticated with an API key from `ANTHROPIC_API_KEY` by default. Every Model id is accepted; `knownModelIds` lists current Claude aliases as completions. Tools are sent without strict schema validation, so an Agent can offer more than Anthropic's 20 strict Tools per request; annotate a Tool with `Tool.Strict` to make it strict. `generateObject` uses Anthropic's native JSON output format on Models that support it. Responses and streams that omit optional usage fields decode. On Models that accept system Messages mid-conversation, a later system Message can be sent in the message history, after a user group and before the next assistant group or at the end; otherwise it goes into the top-level system prompt.

`MissingCredentialError` is exported from `@mitome/providers/anthropic`; a configuration source that cannot be read fails Model provisioning with its `ConfigError`.
