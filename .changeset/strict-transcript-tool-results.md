---
"@mitome/core": patch
---

A Tool result whose encoded form is not JSON no longer becomes `null` in the Model Prompt and committed Messages. It reaches the next Model Prompt as the Tool produced it, and saving the Transcript fails with a `SchemaError` instead of committing an altered Message; the write-only event record still stores `null` for it. A result whose encoded form is a top-level `undefined` (such as `Schema.Void`) is the one exception and still encodes as `null`.
