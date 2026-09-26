---
status: authoring superseded by ADR-0057; package boundary retained
---

# Keep small first-party features together without heavy root imports

The current implementation renamed Plugin to Extension and consolidated the small first-party instruction helpers into `@mitome/sdk/extensions` rather than maintaining `@mitome/plugins`. Preserve the useful packaging boundary: small dependency-free features need not each become a published package, and filesystem or heavy optional dependencies must not leak into the ordinary library root import.

[ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md) retires Extension as mandatory authoring machinery. Reusable functionality becomes ordinary modules/functions/Tools/Layers; no target helper names or subpaths are settled here. Existing packages/exports remain implemented until migration; this documentation change is not a package reorganization.
