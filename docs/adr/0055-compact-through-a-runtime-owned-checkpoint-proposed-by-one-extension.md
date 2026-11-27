---
status: amended by ADR-0056 and ADR-0057
---

# Compact through runtime-validated Checkpoints and replaceable policy

Compaction is a projection, not a rewrite. Preserve every committed Message and derive the Model Prompt from Instructions, the applicable Checkpoint summary framed as a user Message, and retained Messages. Keep canonical history complete for its defined scope so a Checkpoint can be discarded and recomputed. [ADR-0056](0056-separate-history-compaction-and-execution-recovery.md) requires compatible Branch ancestry and summary provenance: never import a discarded future implicitly; carrying abandoned work requires an explicit Branch summary, off by default.

Author-supplied policy proposes; Core validates and owns the transaction. Reject empty summaries, invalid/incompatible retained boundaries, and splits between a Tool call and its results on proposal and persisted decode. A staged Checkpoint may shape later Steps but commits only with successful whole-Turn history save. Failed/interrupted/unsaved Turns leave committed state unchanged; recovery separately restores staged Compaction without publishing unfinished conversation or replaying completed Tools. Core owns neither threshold nor retention policy. Ephemeral Step shaping remains distinct ([ADR-0024](0024-compose-instructions-from-plugin-fragments.md)).

[ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md) replaces the single Extension `compact` Hook and Promise manual operation with ordinary native functions. Preserve replaceable trigger/boundary/summarization seams, importable useful defaults, custom/composed policy, and manual Compaction between Turns with busy rejection. Exact operations and Checkpoint types wait for #170 → #168 → #169; none of the earlier helper spellings is a shipped contract.

Known context windows have one source: Provider metadata (#166), not a Compaction override. Defaults need no extra configuration when metadata is known and stay inactive when it is unknown. Policy can inspect canonical Messages, applicable Checkpoint, selected Model metadata and relevant usage, with controlled no-tools summarization. Invalidate stale usage at Session start, Model change and Checkpoint application. Summaries are not tied to the Model that produced them; a smaller window may require Compaction again.

Preserve tests for independent Branches, navigation before/after Compaction, explicit Branch summaries, malformed persisted state, Tool-loop integrity and staged recovery. A valid retained boundary may leave the current request inside the summary; carrying its intent is the summarizer's responsibility. Portable overflow compact-and-retry remains deferred until classification is portable; if added, bound it to once per Turn and never replay a Step that executed Tools.
