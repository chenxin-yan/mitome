---
"@mitome/core": minor
"@mitome/sdk": minor
---

Remove Extension dependency injection through `dependencies`, `provides`, and `getService`; compose Extensions in Agent Definition order instead. Extension names are now optional. Reusing one Extension object contributes it once, while different Extensions with the same name are rejected.
