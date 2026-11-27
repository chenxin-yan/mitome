---
status: amended by ADR-0057
---

# Register cleanup as acquisition succeeds

Register release immediately after each successful acquisition, so a later acquisition failure cannot leak earlier resources. Unwind in reverse acquisition order on success, failure and interruption, allowing dependents to release before their dependencies. Continue remaining cleanup even if one release fails; preserve a primary operation error, and report cleanup failure when it is the only failure.

[ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md) replaces Promise `resource: async ({ defer })` and mandatory Extension lifetime/Hook order with native scoped Effect/Layer acquisition. Preserve partial-acquisition safety and LIFO finalization rather than reimplementing a disposal stack or requiring Extension-private resources. Exact Session and infrastructure lifetimes must be proven; a shared memoized Layer is not proof of fresh Session state.
