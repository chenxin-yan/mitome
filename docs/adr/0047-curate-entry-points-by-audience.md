---
status: amended by ADR-0057
---

# Curate explicit public entry points

Every package entry point uses explicit named exports rather than `export *`, so internal plumbing and future exports cannot silently become public API. Document supported consumers and stability boundaries deliberately.

[ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md) supersedes the Promise-first/separate-Effect-facade audience policy. Native Effect is the canonical target library surface; Hosts and CLI/TUI consume that same library, not a second agent API. Exact package/subpath/export layout waits for contract proofs. Current source still exposes the Promise SDK and Effect facade until migration; removing obsolete reference pages does not change exports.
