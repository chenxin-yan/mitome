---
"@mitome/core": minor
"@mitome/sdk": minor
"@mitome/providers": minor
"@mitome/channels": minor
"@mitome/tui": minor
"create-mitome": patch
---

Mitome now depends on the exact Effect `4.0.0` stable release instead of `4.0.0-rc.108`. Applications that use Effect directly with Mitome must upgrade their own `effect` dependency to `4.0.0` so both share one Effect version, and must import the modules Effect moved out of `effect/unstable/*` from their new paths (for example `effect/ai`, `effect/http`, `effect/cli`). New `create-mitome` projects using the Effect template pin `effect` at `4.0.0`.
