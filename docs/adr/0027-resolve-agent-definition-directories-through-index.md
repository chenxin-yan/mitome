---
status: amended by ADR-0057
---

# Resolve explicitly selected directories through index.ts

Retain directory resolution and explicit trust; [ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md) replaces the Agent Definition authoring contract. The following selector behavior exists today; it does not fix the new composition value's signature.

Every CLI `--use` selector accepts either an explicit TypeScript Agent Definition module or an Agent Definition directory, which resolves only to its `index.ts`; run, install, and authentication resolve that selector once before downstream work. Without `--use`, Mitome loads the XDG config directory's `index.ts`, and both `mitome init` and `npm create mitome` generate `index.ts`, with project scaffolds teaching `--use .`; there is no legacy filename fallback, package-style probing, or implicit cwd loading. This amends ADR-0007 and ADR-0023 while preserving their trust boundary: Mitome executes project-local TypeScript only when the user explicitly selects its module or directory.
