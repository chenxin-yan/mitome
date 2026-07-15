---
status: amended by ADR-0017
---

# Treat model identifiers as hints, not a registry

Both provider packages type their required model parameter as `KnownModelId | (string & {})`: a hand-maintained union of known IDs provides editor autocomplete, and arbitrary, future, private, or fine-tuned IDs always pass through to the backend unchanged. Mitome has no runtime model catalog, catalog fetch, model picker, pricing, or capability metadata; the backend is the only entitlement authority, and its model-rejection errors surface as ordinary provider failures. The hint unions are updated by hand per package release because no stable public discovery endpoint exists for either backend.
