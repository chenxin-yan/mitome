---
status: amended by ADR-0057
---

# Distinguish expected Tool outcomes from defects

A declared, schema-validated expected Tool failure is an outcome the Model may inspect and react to; implementation defects and invalid results must not leak raw errors or secrets into the Model or remote responses. Validate declared success/failure schemas, including transformed results, and preserve this distinction through controlled execution.

[ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md) replaces the Promise-specific `ok`/`fail` convention with native Tool/Schema/Effect authoring. The precise error/value mapping remains an API proof task, not a reason to duplicate native Tool representations or claim an unverified helper is exported.
