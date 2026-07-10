---
status: amended by ADR-0014 and ADR-0015
---

# Publish core and CLI packages

The MVP publishes `@mitome/core` and `@mitome/cli`. Core owns the complete public in-process Interface through `defineAgent`, `definePlugin`, and `createSession`; compilation and single-Step machinery remain internal. CLI depends on Core, installs the `mitome` binary, and contains only Bun Definition loading and interactive terminal I/O. “SDK” describes programmatic use of Core rather than a third package.
