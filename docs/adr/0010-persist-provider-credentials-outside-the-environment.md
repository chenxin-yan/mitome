---
status: amended by ADR-0013, ADR-0031
---

# Persist provider credentials outside the environment

Mitome stores provider Credentials in `<config-dir>/auth.json` with mode 0600, one Credential per provider id and a single account per provider. OAuth refresh tokens rotate, so every refresh rewrites the file atomically under a cross-process file lock; two concurrent `mitome` processes must never race a rotating refresh token. `mitome auth logout` deletes the provider's entry. Credential storage is independent of conversation and execution storage; [ADR-0056](0056-separate-history-compaction-and-execution-recovery.md) supersedes the original MVP's no-history-persistence scope. These credential guarantees remain required during the native redesign.
