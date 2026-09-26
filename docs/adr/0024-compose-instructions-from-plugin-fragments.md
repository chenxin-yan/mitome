---
status: amended by ADR-0057
---

# Compose ordered static Instructions separately from Step shaping

Preserve explicitly ordered static Instructions: skip empty fragments, join non-empty fragments with blank lines, and omit the system Message when none exist. Keep ephemeral per-Step Model Prompt shaping distinct from persistent conversation and branch-valid Compaction. [ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md) removes the mandatory Extension/Hook mechanism, not these semantics; exact native functions remain open.

Explicit file paths and discovery remain separate. Relative explicit paths require an explicit base, with missing files failing rather than being silently ignored; reuse completed #167. Discovery accepts explicitly selected bare filenames, collects existing files outermost-first from the Git root to the working directory (only the working directory outside a repository), and skips absent names. Core must not infer a filesystem discovery convention from an opaque Agent function. Model context projections must not mutate canonical history or import a discarded Branch's future.
