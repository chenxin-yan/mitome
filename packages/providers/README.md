# @mitome/providers

Current first-party Provider subpaths: `@mitome/providers/openai`, `@mitome/providers/openai-compatible`, and `@mitome/providers/openai-codex`. There is no root import. Codex uses an unofficial ChatGPT endpoint and remains best-effort.

Each factory returns a Core Provider to list in `defineMitome({ providers })`; see the [applications guide](https://mitome.sh/docs/applications). Authenticate Codex with its `login` export or, from the Mitome CLI, `mitome auth login --app <file> --provider openai-codex`; pass the same `configDirectory` to `codex()` and the application when overriding it.
