---
"@mitome/core": patch
"@mitome/providers": patch
"create-mitome": patch
---

The packages are built with `vp pack` instead of `tsc`, with the same public modules, types and pure-call annotations. What changes in the tarballs:

- Each `exports` entry names its JavaScript file only, without a `types` condition; TypeScript finds the declarations beside it (`dist/index.d.ts` beside `dist/index.js`), as before.
- Declarations are written only for modules a public type reaches. No longer shipped, and never importable through `exports`: `@mitome/core`'s `dist/agent/run.d.ts` and `dist/session/internal.d.ts`; `@mitome/providers`'s `dist/anthropic/login.d.ts`, `dist/anthropic/profile.d.ts`, `dist/openai/transport.d.ts`, `dist/shared/model-http-client.d.ts` and `dist/openai-codex/{constants,credential-store,model,request,sse,transport}.d.ts`; `create-mitome`'s `dist/application.d.ts`.
- `@mitome/core` adds `dist/_virtual/_rolldown/runtime.js`, which builds the `Agent`, `Extension`, `Mitome`, `Provider` and `Session` namespace objects, and `create-mitome` adds `dist/package.js`, the package version the template pins, read at build time instead of from `package.json` at run time.
