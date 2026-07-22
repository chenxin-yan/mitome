# Compose instructions from Plugin fragments

The Agent Definition drops its `instructions` field and shrinks to two fields — one Model and an ordered Plugin list; a Plugin may instead contribute an optional static Instructions fragment (`instructions?: string`, plain markdown, no title/body structure). At Session creation Core composes the system prompt once: fragments in Plugin definition order, empty fragments skipped, joined with `"\n\n"`; when no Plugin contributes, the Session has no system message at all rather than an empty one. Fragments are append-only — no override or precedence mechanism — and Core never reads the filesystem; file-backed and inline instructions are first-party Plugins in `@mitome/plugins`. Dynamic per-Step prompt shaping remains the `preStep` Hook's job and stays ephemeral; the two mechanisms are deliberately distinct. We rejected a first-class file-source type on the Definition (path-resolution semantics for one saved line of userland code) and an Eve-style filesystem discovery convention in Core (a compiler/discovery pipeline contradicting configuration-over-convention). This amends ADR-0008 (Definition field set) and ADR-0004 (Plugin contribution set).

## Consequences

- Two Plugins with contradicting fragments are resolved only by definition order; the composed prompt is inspectable via session `history()`.
- If fragment provenance is ever needed, the required `Plugin.name` can label sections later without a schema change.
