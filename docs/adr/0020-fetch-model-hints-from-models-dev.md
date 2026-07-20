# Fetch model hints from models.dev

`mitome init` fetches OpenAI and Codex model-ID hints from models.dev, caching the reduced lists in `<config-dir>/models-cache.json` for 24 hours. A fresh cache is used without a request; an expired cache refreshes when possible, otherwise remains usable, and the provider packages' hand-maintained hints are the offline fallback. Agent runs never fetch the catalog.

The catalog is a convenience for init's selector, not a registry or entitlement authority: arbitrary IDs still pass through and provider errors remain authoritative. Runtime fetching is limited to init rather than a bundled snapshot or a general registry because no current runtime feature consumes pricing, limits, or capability metadata. This amends only ADR-0012's not-fetched and hand-maintained-only clauses; everything else stands, and the hand-maintained hints remain as the offline fallback and type-level hints.
