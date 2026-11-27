---
"@mitome/providers": minor
---

`@mitome/providers` now builds on `@mitome/core`: `openai()`, `openaiCompatible()` and `codex()` return `Provider.Provider` values created with `Provider.make`, and `@mitome/core` is the peer dependency. The package now depends on `@effect/platform-node-shared`, the Node implementation of the Effect services it uses, which Bun also runs.

Codex Credentials live in the Mitome state directory (`stateDirectory()` from `@mitome/core`) instead of the config directory. The `configDirectory` option of `codex()`, `login` and `logout` is renamed `stateDirectory`; `auth.json` keeps its name, mode, atomic rewrite and lock. `login` and `logout` return Effects instead of Promises, and `login` reads a pasted redirect URL through its `input` Effect; interrupting `login` closes its callback server and stops reading input. Codex credential errors now name `mitome auth login --provider openai-codex`.

Codex keeps every system Message as its instructions and replays assistant text in its original order. It sends a Tool's mapped model output (`toModelOutput`) in place of its result, and refuses a user `file` part, a `file` part in a Tool's model output or a JSON response format before sending, instead of dropping it. A token endpoint answering 429 or 5xx is reported as a temporary, retryable failure instead of an expired sign-in.

An OpenAI response cut off by `max_output_tokens` is an incomplete Step with reason `length` instead of Tool calls. Whether an OpenAI Model id is a reasoning Model, which decides the role of system Messages and whether encrypted reasoning is requested, follows `@effect/ai-openai`: `gpt-5.2-chat-latest` and `gpt-5.3-chat-latest` are not reasoning Models, and `gpt-realtime-2.1` is one.

A missing API-key environment variable now fails `openai()` and `openaiCompatible()` Model provisioning with a `MissingCredentialError` (tag `MissingCredentialError`, same message text, exported from both entry points) instead of a bare string. A configuration source that cannot be read fails with its `ConfigError` instead.
