# Generate model hints from models.dev

Model-hint lists are no longer hand-copied across packages. An explicit refresh (`bun run hints:refresh`) fetches models.dev, filters the OpenAI provider to tool-capable models, and updates the committed snapshot (`scripts/models-dev.snapshot.json`, the reviewable diff surface). A deterministic Turbo task then reads that snapshot and emits two git-ignored modules ahead of build, lint, and typecheck: the `knownModelIds` hints of `@mitome/providers/openai` and create-mitome's prompt list. The task declares its source inputs and generated outputs, so generation and dependent builds cache independently while normal builds stay offline and deterministic. create-mitome keeps its zero-dependency install without hand-mirroring the lists. Qualified Model ids keep their `string & {}` suffix pass-through: hints are not a registry or entitlement authority, so a stale list costs autocompletion, never capability.

`mitome init` may fetch the OpenAI catalog and caches it at `<config-dir>/models-cache.json` for 24 hours. It uses a fresh cache without a request and falls back to an expired cache, then the generated static hints, when refresh fails. Agent runs never fetch the catalog.

The Codex list is the deliberate exception: `openai-codex/models.ts` stays hand-maintained from OpenAI's Codex documentation, and it feeds `mitome init` suggestions directly. models.dev has no ChatGPT-backend provider record, and deriving Codex ids from live OpenAI ids disagreed with the documented list in both directions. The CLI catalog therefore fetches, caches, and falls back for the OpenAI list only, using the same tool-capable rule as the generator so one derivation exists end to end.

## Consequences

- New OpenAI model launches reach hints after an explicit `bun run hints:refresh`; Codex hints require a hand edit sourced from the Codex docs.
- Normal build, lint, and typecheck tasks perform no network I/O and retain local and remote caching.
- Fresh clones need one deterministic generation run before typechecking; any Turbo build/check/test task performs or restores it automatically.
- The snapshot diff in a PR is the review surface for hint changes.
