# Keep libraries Node-capable with a Bun-native CLI

`@mitome/core`, `@mitome/sdk`, and `@mitome/providers` support Node >=24, declared through `engines` and attested in CI, whose vitest suites execute under Node. The CLI remains Bun-native: it loads TypeScript Agent Definitions and ships compiled binaries that depend on Bun. The OpenAI and OpenAI-compatible provider subpaths remain edge-capable because they use fetch-based HTTP and no filesystem; OpenAI Codex requires its filesystem-backed Credential store and is Node/Bun-only.

Filesystem and process APIs stay confined to the CLI and provider subpaths that need them. New library code may not add Node-only builtins beyond `node:path` without an ADR.
