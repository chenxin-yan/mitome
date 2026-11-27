## Commands

Run the narrowest one that covers the change; `pnpm vp` is the workspace's Vite+.

- Check (format, lint, type-check with Effect's diagnostics): `pnpm vp run check`; fixes: `pnpm run check:fix`. A bare `vp check` misses the Effect diagnostics.
- Every package's tests, from source with nothing built: `pnpm test`; one package's: `pnpm vp run --filter @mitome/core test`.
- The tests of built output (tagged `dist`: declarations, binary, terminal, scaffold, release fixtures), after the builds they need: `pnpm run test:dist`.
- One test file, from its package directory: `pnpm vp test run test/agent/agent.test.ts`; in `packages/cli`, `bun --bun vp test run <file>`.
- Build, including the CLI binary at `packages/cli/dist/local/mitome`: `pnpm run build`.
- The CLI from source, against the git-ignored `.dev-home`: `pnpm run dev:cli <arguments>`.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `chenxin-yan/mitome`; external pull requests are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix` labels. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context layout with root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.

### Packaging

New library code goes in `@mitome/core`: in the root entry if it passes the three tests, otherwise as a subpath. A separate package is for an outside dependency most users do not need. Read `docs/adr/0061-ship-one-package-and-gate-what-enters-its-core.md` before adding a package, a subpath or a root export.

### Lint

Satisfy a lint rule with better code, or with one `oxlint-disable-next-line <rule> -- <reason>` that names the boundary, never by writing the same thing another way (`typeof Schema.Unknown.Type` for `unknown`). A value from outside is decoded with an Effect Schema where it enters; where `unknown` is the honest type, write `unknown`.

<!-- effect-solutions:start -->

## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.
<!-- effect-solutions:end -->
