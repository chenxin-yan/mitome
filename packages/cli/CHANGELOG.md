# @mitome/cli

## 0.1.0

### Minor Changes

- 9c47617: `Host` is now a union discriminated by `kind`. Add `kind: "interactive"` to terminal Hosts and `kind: "channel"` plus a unique `name` to Channel Hosts. `defineMitome({ agent, hosts })` accepts multiple Hosts; the CLI runs the first supported interactive Host, and installing `@mitome/tui` does not activate it until `tui()` is registered.

  Add `mitome serve` to run every registered Channel Host. `handle` Hosts share one listener under `/<name>` using `--port` or port 3000, while `serve` Hosts receive an `AbortSignal`. Core also exports `Routes`, `memoryRoutes()`, and `fileRoutes()` for mapping channel routes to Transcripts.

- 599c0fe: `defineAgent` now accepts an `approvals` policy with `allow`, `ask`, and `deny` Tool-name patterns or a decision callback. The strictest Agent or Extension decision wins, and Agent `allow` bypasses the Tool's own approval predicate. Failed predicates require Host approval instead of running the Tool.

  The TUI prompts for required approvals with `y`, `n`, or `a` to allow a Tool-requested approval for the current Session. Non-interactive runs deny requests by default; pass `--yes` to approve Tool-requested prompts for one invocation. Policy and predicate-error requests are never approved by `--yes`.

### Patch Changes

- 22c3669: Add `mitome ext list`, which prints resolved Extension names and installed versions in Agent Definition order.

  `mitome auth login` and `mitome auth logout` now exit after authentication even when a Definition leaves background work running, and report specific errors for unavailable OAuth Providers or invalid capability modules. Circular diagnostic causes print as `[circular cause]` instead of recursing.

- e367bc0: `create-mitome` and `mitome init` no longer overwrite an existing path, including symlinks and files created during scaffolding. Generated `tsconfig.json` files now set `skipLibCheck: true`, so fresh projects type-check without adding `@types/node` for transitive declarations.
