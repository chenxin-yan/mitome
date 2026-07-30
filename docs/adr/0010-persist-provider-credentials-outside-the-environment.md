---
status: amended by ADR-0013, ADR-0031
---

# Persist provider credentials outside the environment

Mitome stores provider Credentials in `<config-dir>/auth.json` with mode 0600, one Credential per provider id and a single account per provider. OAuth refresh tokens rotate, so every refresh rewrites the file atomically under a cross-process file lock; two concurrent `mitome` processes must never race a rotating refresh token. `mitome auth logout` deletes the provider's entry. This is a deliberate, narrow exception to the MVP's no-persistence posture: it covers Credentials only, while Sessions, history, and runtime state remain unpersisted.
