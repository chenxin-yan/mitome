# Generate model hints from models.dev

Model-hint lists are no longer hand-copied across packages. A build-time generator (`scripts/generate-model-hints.ts`, wired into turbo ahead of build, lint, and typecheck) fetches models.dev, filters the OpenAI provider to tool-capable models, and emits two git-ignored modules: the `knownModelIds` hints of `@mitome/providers/openai` and create-mitome's prompt list — so every release ships current hints without a manual step, and create-mitome keeps its zero-dependency install without hand-mirroring the lists. A successful fetch refreshes a committed snapshot (`scripts/models-dev.snapshot.json`, a reviewable diff surface); a failed fetch emits from that snapshot with a loud warning, so offline development and models.dev outages never block a build, at the accepted cost that builds are not fully deterministic between snapshot refreshes. Hints remain hints (ADR-0012): every `ModelId` keeps its `string & {}` pass-through, so a stale list costs autocompletion, never capability.

The Codex list is the deliberate exception: `openai-codex/models.ts` stays hand-maintained from OpenAI's Codex documentation, and it now feeds `mitome init` suggestions directly — the CLI catalog's former `/codex/i` substring derivation over live OpenAI ids is deleted. models.dev has no ChatGPT-backend provider record, and the substring rule disagreed with the documented list in both directions (it missed documented non-"codex" ids like `gpt-5.6-*` and surfaced API-only ids the backend rejects). Pi reached the same conclusion independently (`generate-models.ts`: "not fetched from models.dev; we keep a small, explicit list to avoid aliases"). The CLI catalog therefore fetches, caches, and falls back for the OpenAI list only, using the same tool-capable rule as the generator so one derivation exists end to end.

This amends ADR-0020 (models.dev remains the live source at `mitome init`; the offline fallback is now generated from it) and reaffirms ADR-0012.

## Consequences

- New model launches reach OpenAI hints on the next build; Codex hints require a hand edit sourced from the Codex docs.
- Fresh clones need one generation run before typechecking; any turbo build/check/test task performs it automatically.
- The snapshot diff in a PR is the review surface for hint changes.
