---
status: amended by ADR-0057
---

# Do not rebuild native dependency injection as a framework graph

Mitome removed a custom Extension dependency/provided-service graph with no non-test consumers. Preserve the rejection of a second named registry, auto-inclusion graph, or framework-specific service wiring when native Effect Context and Layers already compose infrastructure.

[ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md) retires mandatory Extensions, including their private/eager/Definition-order Resource rule. This does not prohibit native shared services or Layers: applications explicitly own their sharing and lifetime, while Session allocation remains fresh and scoped. Providing a service does not make it a Model-visible Tool.
