---
status: amended by ADR-0029
---

# Add a CLI credential bootstrap surface

The CLI gains `mitome auth login [--use <file.ts>]` and `mitome auth logout [--use <file.ts>]`. Authentication is Definition-scoped: the CLI loads the selected trusted Definition and delegates to its Model's provider-owned credential descriptor, so the generic auth path carries no provider registry. `mitome init` separately owns the static scaffold choices: API-key OpenAI writes the masked key to `<config-dir>/.env`, while Codex immediately runs the same provider-owned OAuth login used by `mitome auth login`. OAuth providers persist into `auth.json` (ADR-0010). At startup the CLI — and only the CLI — loads `<config-dir>/.env` into the process environment without overriding existing variables; Core resolves declarative environment credential descriptors from `process.env`, so there is one credential-resolution mechanism with two layers. Embedded SDK sessions read `process.env` untouched. Init generates no `.env.example`.
