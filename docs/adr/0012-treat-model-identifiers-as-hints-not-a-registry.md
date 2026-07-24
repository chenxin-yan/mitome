---
status: amended by ADR-0017, ADR-0020, and ADR-0029
---

# Treat model identifiers as hints, not a registry

Provider packages with known model hints accept `KnownModelId | (string & {})` and export the hand-maintained hints as `knownModelIds`; arbitrary, future, private, or fine-tuned IDs still pass through unchanged. `mitome init` offers provider and model selectors for the official OpenAI and Codex providers, with a custom-ID escape hatch. OpenAI-compatible is excluded from init because compatible endpoints have no shared model catalog. These hints are not fetched or authoritative: Mitome carries no pricing or capability metadata, the backend remains the entitlement authority, and model-rejection errors surface as ordinary provider failures. The hints are updated by hand per package release because no stable public discovery endpoint exists.
