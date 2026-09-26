---
status: amended by ADR-0057
---

# Preserve lifecycle and Tool validation without mandatory Plugins

[ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md) replaces declarative Plugin/Extension values and mandatory Hooks with ordinary Effect composition and native Tool/Toolkit/Schema/model types. Preserve the behavioral boundaries: unrecovered startup/Turn failures fail that operation; cleanup still completes without replacing a primary failure; denied Tool execution returns a typed, sanitized denial to the Model without running the handler; transformed Tool results are revalidated against their declared success/failure schemas before entering history. Reject ambiguous duplicate model-visible Tool names before execution.

Scoped finalization must unwind successfully acquired resources in reverse order ([ADR-0054](0054-acquire-resources-with-a-setup-scoped-defer.md)). Exact lifecycle interception operations remain open; no universal Definition-order Hook protocol or direct upstream Chat-as-history-authority is selected for the redesign.
