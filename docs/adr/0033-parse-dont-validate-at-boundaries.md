---
status: amended by ADR-0057
---

# Parse untrusted boundaries once

Decode untrusted serialized inputs into typed values before use: credential files, OAuth responses, claims, Provider events, catalogs/caches, package metadata, IPC and persisted state. Preserve intentional protocol tolerances, including forward-compatible unknown Provider event kinds and treating a corrupt catalog cache as a miss; map parse failures to deliberate sanitized diagnostics. Aggregate structural/semantic configuration problems deterministically where independent errors can be reported together, rather than discovering them piecemeal during execution.

Live typed construction need not become a serialized Schema pipeline. [ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md) replaces Agent Definition compilation and Plugin-specific constructors; exact native configuration schemas and dynamic module validation remain proof tasks. Preserve early duplicate Tool-name detection before native Toolkit construction can erase a collision. Static typing does not validate a dynamically imported module or stored bytes.
