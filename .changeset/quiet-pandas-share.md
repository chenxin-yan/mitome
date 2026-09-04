---
"@mitome/core": minor
"@mitome/sdk": minor
---

Remove Extension dependency injection (`dependencies`, `provides`, and `getService`); compose Extensions explicitly in Agent Definition order and keep Resources private to their owning Extension. Extension names are optional: repeating the same object contributes it once, separate anonymous values remain distinct, and different values sharing a name fail compilation.
