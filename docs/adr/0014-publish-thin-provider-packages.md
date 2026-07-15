---
status: amended by ADR-0017
---

# Publish thin provider packages

The MVP publishes `@mitome/openai` (and `@mitome/openai-codex`, ADR-0011) alongside Core and CLI, extending ADR-0009's published set. A provider package exposes one factory that takes a required provider-native model identifier (typed per ADR-0012) plus a declarative credential descriptor and returns Core's opaque canonical Model value (ADR-0016) — client, HTTP, and Layer wiring stay hidden inside the package. This supersedes ADR-0002's remaining guidance that Definition authors wire `@effect/ai-openai` and its dependencies directly; Definitions never import Effect provider packages themselves. Provider packages pin their Effect dependencies in lockstep with Core (ADR-0001) and add no capability, routing, or catalog behavior.
