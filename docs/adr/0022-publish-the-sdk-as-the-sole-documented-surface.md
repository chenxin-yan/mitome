---
status: amended by ADR-0034, ADR-0047
---

# Publish the SDK as the sole documented surface

Users install `@mitome/sdk` with `@mitome/providers` and `@mitome/plugins`. Promise-first APIs remain at `@mitome/sdk`; the complete Effect-native API is re-exported unchanged from `@mitome/sdk/effect`, preserving runtime identity for errors, Context tags, and other Core values. The two subpaths intentionally expose different `TurnEvent` shapes: Promise events at the root and Effect events under `/effect`.

`@mitome/core` remains published as the internal runtime engine required by the SDK, providers, and CLI Host, but it is no longer a documented user-facing surface. SDK and provider tarballs retain exact Core peer dependencies while Effect is beta. Bun installs those peers for generated Agent Definition projects, so `mitome init` lists only the SDK, providers, and Plugins as direct dependencies while the Host can still resolve Core beside the Definition.

This amends ADR-0015's power-user Core surface. It does not merge Core into the SDK or introduce wrappers for the Effect API.
