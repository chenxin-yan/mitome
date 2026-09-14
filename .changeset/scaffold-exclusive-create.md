---
"create-mitome": patch
"@mitome/cli": patch
---

`create-mitome` and `mitome init` no longer overwrite an existing path, including symlinks and files created during scaffolding. Generated `tsconfig.json` files now set `skipLibCheck: true`, so fresh projects type-check without adding `@types/node` for transitive declarations.
