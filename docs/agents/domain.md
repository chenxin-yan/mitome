# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout

This is a single-context repository:

- `CONTEXT.md` at the repository root contains the shared domain language.
- `docs/adr/` contains architectural decisions.

## Before exploring, read these

- `CONTEXT.md`
- ADRs under `docs/adr/` that touch the area being changed

If these files don't exist, proceed silently. The `/domain-modeling` skill creates them lazily when terms or decisions are resolved.

## Use the glossary's vocabulary

When output names a domain concept, use the term defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If a needed concept isn't in the glossary, reconsider whether the language is invented or note the real gap for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface it explicitly rather than silently overriding it.
