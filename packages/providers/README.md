# @mitome/providers

Current first-party Provider subpaths: `@mitome/providers/openai`, `@mitome/providers/openai-compatible`, and `@mitome/providers/openai-codex`. There is no root import. Codex uses an unofficial ChatGPT endpoint and remains best-effort.

Each factory returns a `@mitome/core` Provider to list in `Mitome.make({ providers })`; see the [applications guide](https://mitome.sh/docs/applications). Authenticate Codex by running the Effect its `login` export returns or, from the Mitome CLI, `mitome auth login --provider openai-codex`; Credentials live in the Mitome state directory: direct `login` and `logout` callers must pass a resolved `stateDirectory`; only `codex()` defaults it, and needs the option only when the directory differs from that default.
