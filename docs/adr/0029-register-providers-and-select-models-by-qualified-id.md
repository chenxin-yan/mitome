---
status: amended by ADR-0057
---

# Select Models by Provider-qualified identity

Preserve Provider identity, a Default Model and per-Turn selection using Qualified Model ids written as `provider/model`; split at the first slash so the native id may contain later slashes. Reject duplicate Provider ids and unknown Provider selection before model execution. Catalogs are hints, not entitlements or a closed list; Provider order never implies fallback or routing.

[ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md) replaces registration inside a mandatory Agent Definition with user-owned composition. One descriptor set must supply offline catalog/auth discovery and runtime provisioning, without duplicate defaults or opening a Session to authenticate. Exact descriptor/Layer signatures and model resource lifetimes require proof; preserve lazy model acquisition and scoped release, not the old sealed `makeProvider` signature as a target requirement.

Reuse generated context-window metadata (#166), keep unknown windows unknown, and preserve explicit transport selection and Provider-owned credential defaults. Authentication may select the only eligible Provider or ask when several exist; no automatic fallback, inferred service identity, global registry, or parallel Promise transport API is introduced.
