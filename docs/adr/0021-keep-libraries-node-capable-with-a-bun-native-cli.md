# Keep libraries Node-capable with a Bun-native CLI

`@mitome/core`, `@mitome/sdk`, `@mitome/providers`, and `@mitome/channels` support Node >=24, declared through `engines` and attested in CI, whose vitest suites execute under Node. The CLI remains Bun-native: it loads explicitly selected TypeScript compositions and ships compiled binaries that depend on Bun. The OpenAI provider selects WebSocket transport on Bun and Node and fetch-based HTTP on other runtimes; OpenAI-compatible remains fetch-based HTTP. OpenAI Codex requires its filesystem-backed Credential store and is Node/Bun-only.

Filesystem and process APIs stay confined to the CLI and provider subpaths that need them, plus the explicit instruction-file loading sanctioned by ADR-0024 (currently in `@mitome/sdk/extensions`). New library code may not add other Node-only builtins beyond `node:path` without an ADR.
