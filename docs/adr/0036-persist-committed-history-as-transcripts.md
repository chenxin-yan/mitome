---
status: amended by ADR-0040, ADR-0056 and ADR-0057
---

# Persist committed history as versioned Transcripts

A Transcript is a durable, Schema-backed record of committed conversational Messages, distinct from a live Session and unfinished Execution state. [ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md) sets one whole-function Turn commit boundary: stage across generations, then publish only after successful completion and durable save when configured. Failure before commit does not publish partial conversation; event/delivery failure after commit does not undo it. Opening from persisted history allocates fresh scoped resources rather than reviving process objects.

Persisted bytes are untrusted: preserve supported Message/content-part information without silently changing or dropping values; reject unsupported live values at the serialization boundary. Unknown schema versions fail decoding. Once published, format changes require sequential migrations, fixtures for each supported prior version, and rejection when no migration chain exists; stores write the current encoding, never guess an unknown version.

[ADR-0056](0056-separate-history-compaction-and-execution-recovery.md) replaces the original exclusion of mid-Turn recovery and Approval restoration. It also selects Transcript as the owner of the committed History tree and Checkpoints, with a selected Branch's linear conversation derived as a projection. Concrete persistence identities/schema still belong to #170; no new public schema is selected here. Execution recovery restores explicit durable operations separately from committed conversation. A passive event log is observability, not authority to reconstruct state or rerun effects. The current process-bound implementation is not proof of the target recovery guarantee.
