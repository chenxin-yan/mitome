---
status: superseded by ADR-0029
---

# Represent models as an opaque canonical value

Core exports a branded `Model` value whose public type mentions no Effect; provider factories return it, and internally it carries the fully provisioned Effect AI Model. A separate SDK package alone does not keep Effect out of generated declarations — a raw Effect AI Model in the Definition field would leak Effect types into `@mitome/sdk` hovers and provider `.d.ts` files. SDK and Core Definitions accept the same canonical value without wrapping or conversion, and Effect-native authors can still reach the underlying provisioned model through Core. This supersedes ADR-0008's wording that the Definition holds a raw fully provisioned Effect AI Model.
