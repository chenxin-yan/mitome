---
status: amended by ADR-0056 and ADR-0057
---

# Build the CLI on the public in-process runtime

The CLI/TUI consumes the same headless library execution implementation as embedded applications; no Host owns a second model/Tool loop. Sessions are explicitly scope-owned and reject simultaneous Turns rather than silently queueing or branching. Turn interruption leaves committed conversation unchanged and permits later work while the Session remains live; closing its Scope releases its resources.

[ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md) replaces Definition/Plugin and stream-owned authoring with plain Effect programs and whole-function Turns. Its TUI and HTTP scope replaces the original HTTP deferral. [ADR-0056](0056-separate-history-compaction-and-execution-recovery.md) replaces the original ephemeral-only release scope with explicit durable recovery. These are target semantics, not current API guarantees.
