---
status: amended by ADR-0057 and ADR-0061
---

# Curate explicit public entry points

Every package entry point uses explicit named exports rather than `export *`, so internal plumbing and future exports cannot silently become public API. Document supported consumers and stability boundaries deliberately.

[ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md) supersedes the Promise-first/separate-Effect-facade audience policy. Native Effect is the canonical target library surface; Hosts and CLI/TUI consume that same library, not a second agent API. Exact package/subpath/export layout waits for contract proofs. Current source still exposes the Promise SDK and Effect facade until migration; removing obsolete reference pages does not change exports.

[ADR-0061](0061-ship-one-package-and-gate-what-enters-its-core.md) names things as Effect does (`Provider.make`, `Session.make`), which an entry point writes as `export * as Provider from "./provider.js"`. That form is allowed. The module's own export list is then public surface, so a namespace module exports only public names and keeps its internals in a module no entry point exports. The lint rule refuses only the flat `export * from`.
