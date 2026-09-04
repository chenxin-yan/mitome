---
"@mitome/core": minor
"@mitome/sdk": minor
---

Replace standalone `tool()` declarations with scoped builders in `defineAgent({ tools })` and `defineExtension({ tools })`. Omit `outputSchema` to infer unvalidated outputs, or declare `failureSchema` and return `ok()` / `fail()` for schema-checked expected failures visible to the Model; thrown errors remain opaque.
