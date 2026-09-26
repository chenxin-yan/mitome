---
status: amended by ADR-0050, ADR-0051 and ADR-0057
---

# Keep one-shot CLI execution non-interactive

One-shot output runs one Turn, streams presentation to stdout, and exits without waiting for a person. Explicit print mode and non-TTY stdout force one-shot behavior; otherwise explicitly declared interactive Hosts form an ordered fallback chain. Installing a Host alone never activates it. Unsupported terminals report why they fall back. Credential bootstrap may remain interactive because it is setup, not a Turn.

A required Approval with nobody present is denied with a stable Model-visible reason; policy asks and predicate failures must never be auto-approved. Any explicit convenience grant may cover only the Tool author's ask and cannot override stricter author policy. The TUI presents permitted asks. [ADR-0051](0051-let-the-agent-author-decide-tool-approvals.md) owns authority, not command-line spelling.

Serving declared Channels is the explicit long-lived CLI role, separate from one-shot invocation. [ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md) makes TUI and HTTP initial consumers of the same native library execution; exact composition contracts remain pending. Embedded programs remain Host-independent.
