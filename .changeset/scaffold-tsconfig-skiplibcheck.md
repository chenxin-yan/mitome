---
"create-mitome": patch
---

The generated `tsconfig.json` sets `skipLibCheck: true`. A fresh scaffold has no `@types/node`, and Effect's transitive declarations (msgpackr) reference Node globals, so `tsc` in a new project failed inside `node_modules` before reaching any user code.
