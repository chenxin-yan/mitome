---
status: amended by ADR-0055, ADR-0056 and ADR-0057
---

# Compose persistence explicitly

User composition owns persistence; a Host never infers, discovers, or creates an implicit store. Hosts sharing a composition use its shared persistence semantics and resume source rather than independent per-Host truth. Embedded applications may explicitly omit durability. [ADR-0056](0056-separate-history-compaction-and-execution-recovery.md) nevertheless requires durable recovery for the full replacement milestone, distinct from committed Transcripts.

[ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md) replaces the Promise store and Definition-field prescriptions with native composition; exact operations, backend and crash guarantees belong to #170. No store signature or default location is newly selected. Compaction is required, not deferred until measured pressure. Dependency-free adapters may share the library; adapters requiring drivers should not add those dependencies to every consumer.
