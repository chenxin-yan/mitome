---
"@mitome/sdk": minor
"create-mitome": patch
---

`instructionFiles` resolves relative `paths` against an explicit `base`, the calling module's `import.meta.url`, instead of inspecting the call stack for the calling module. Relative `paths` without `base` no longer typecheck; absolute `paths` and `discover`-only calls are unchanged. `create-mitome` scaffolds pass `base: import.meta.url`.
