---
status: amended by ADR-0015
---

# Use Effect in extension APIs

Mitome Definitions remain plain typed values, while Tool handlers and Plugin lifecycle Hooks use Effect v4 directly. The MVP pins `effect` and every Effect provider package to `4.0.0-beta.98`; upgrades are deliberate and revalidated against source and tests. This keeps typed errors and dependencies across extension seams without maintaining a second Promise-based public Interface.
