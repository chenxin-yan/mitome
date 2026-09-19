# create-mitome

## 0.1.0

### Patch Changes

- bf6847a: `instructionFiles` resolves relative `paths` against an explicit `base`, the calling module's `import.meta.url`, instead of inspecting the call stack for the calling module. Relative `paths` without `base` no longer typecheck; absolute `paths` and `discover`-only calls are unchanged. `create-mitome` scaffolds pass `base: import.meta.url`.
- e367bc0: `create-mitome` and `mitome init` no longer overwrite an existing path, including symlinks and files created during scaffolding. Generated `tsconfig.json` files now set `skipLibCheck: true`, so fresh projects type-check without adding `@types/node` for transitive declarations.
