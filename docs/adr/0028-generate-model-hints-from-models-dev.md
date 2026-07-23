# Generate model hints from models.dev

Model-hint lists are no longer hand-copied across packages. An explicit refresh (`bun run refresh:hints`) fetches models.dev, filters the OpenAI provider to tool-capable models, and updates the committed snapshot (`scripts/models-dev.snapshot.json`, the reviewable diff surface). A deterministic Turbo task then reads that snapshot and emits two git-ignored modules ahead of build, lint, and typecheck: the `knownModelIds` hints of `@mitome/providers/openai` and create-mitome's prompt list. The task declares its source inputs and generated outputs, so generation and dependent builds cache independently while normal builds stay offline and deterministic. create-mitome keeps its zero-dependency install without hand-mirroring the lists. Hints remain hints (ADR-0012): every `ModelId` keeps its `string & {}` pass-through, so a stale list costs autocompletion, never capability.

The Codex list is the deliberate exception: `openai-codex/models.ts` stays hand-maintained from OpenAI's Codex documentation, and it now feeds `mitome init` suggestions directly — the CLI catalog's former `/codex/i` substring derivation over live OpenAI ids is deleted. models.dev has no ChatGPT-backend provider record, and the substring rule disagreed with the documented list in both directions (it missed documented non-"codex" ids like `gpt-5.6-*` and surfaced API-only ids the backend rejects). Pi reached the same conclusion independently (`generate-models.ts`: "not fetched from models.dev; we keep a small, explicit list to avoid aliases"). The CLI catalog therefore fetches, caches, and falls back for the OpenAI list only, using the same tool-capable rule as the generator so one derivation exists end to end.

This amends ADR-0020 (models.dev remains the live source at `mitome init`; the offline fallback is now generated from it) and reaffirms ADR-0012.

## Consequences

- New OpenAI model launches reach hints after an explicit `bun run refresh:hints`; Codex hints require a hand edit sourced from the Codex docs.
- Normal build, lint, and typecheck tasks perform no network I/O and retain local and remote caching.
- Fresh clones need one deterministic generation run before typechecking; any Turbo build/check/test task performs or restores it automatically.
- The snapshot diff in a PR is the review surface for hint changes.
