---
status: amended by ADR-0029 and ADR-0057
---

# Keep credential bootstrap independent of Sessions

The CLI's login/logout/bootstrap uses Provider-owned credential metadata from the explicitly selected trusted composition, not a second global Provider registry. [ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md) requires discovery/authentication without opening a Session or acquiring authenticated model resources; the same Provider descriptors must drive runtime provisioning. Exact native descriptor and module contracts remain open.

Retain CLI-only loading of `<config-dir>/.env` without overriding existing environment variables; embedded applications supply their own environment. API-key bootstrap writes masked input to that file, while OAuth Providers own their login flow and persist credentials in `auth.json` under [ADR-0010](0010-persist-provider-credentials-outside-the-environment.md). Neither secrets nor authentication belong in Agent Instructions, model input, or a Session allocation side effect.
