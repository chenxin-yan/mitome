---
status: accepted
---

# Build with Vite+ on pnpm, and keep Bun for the CLI

The repository's toolchain is Vite+ (`vp`) on pnpm. One root `vite.config.ts` holds the format, lint and commit-hook settings; `vp check` formats, lints and type-checks the whole repository and is the one static gate, run through `effect-tsgo` so that its linter and type-checker carry Effect's diagnostics without depending on a patched `node_modules`; the install patches the `typescript` package's `tsc` (`effect-tsgo patch`, which writes a new file and leaves the package store alone) only so that editors show the same diagnostics; `vp run` tasks replace turbo; `vp test` runs vitest, the one test runner. pnpm installs the workspace, owns its catalog and lockfile, and packs the release tarballs.

Bun stays where it is the product's runtime: the CLI and its terminal UI (OpenTUI needs Bun), the single binary from `bun build --compile`, the scripts that use Bun's APIs, and the source CLI. `mitome init` still installs a person's Configuration with the binary's built-in Bun installer. Tests that need the Bun runtime run vitest under Bun (`bun --bun vp test`); every other package's tests run vitest on Node, so the libraries' Node support of [ADR-0021](0021-keep-libraries-node-capable-with-a-bun-native-cli.md) is still what CI attests.

The lint rules come from four places, and none is copied when a package can supply it. `@cloudflare/oxlint-config` is the base: the author of the anti-slop rules this repository used to vendor now recommends it, it carries twelve of them as `quality/*`, and it is maintained with Vite+. Oxlint's correctness category stays on beside it. What remains vendored under `tools/oxlint/anti-slop/` is only what that preset lacks: five general rules and five for Effect. The repository's own rules are one plugin, `tools/oxlint/mitome.ts`, and the import fences. A rule from the preset is turned off only in `vite.config.ts`, with the reason beside it; three are (`import/no-namespace`, `typescript/no-unsafe-type-assertion`, `vitest/no-conditional-expect`). Effect's checker keeps its own defaults.

The research, with the measurements on a migrated copy of this repository, is in `docs/research/toolchain.md`; the development-loop study it builds on is `docs/research/dev-environment.md`.

## Considered options

- **Stay as today** (Bun, turbo, oxlint, oxfmt, vitest, a patched `tsc` per package). Six tools and four config files for what one tool now does.
- **All-in Bun.** At Bun 1.4.5 its linter is canary only, `bun check` misses Effect's diagnostics, the vitest suites do not run under `bun test`, and there is no task cache or declaration output.
- **Vite+ with Bun as the package manager.** It works, but no project that uses Vite+ was found on that path; pnpm is what Vite+'s documentation, its adopters and the owner's other project use.
- **Node only.** OpenTUI needs the Bun runtime, the binary comes from `bun build --compile`, and `mitome init` uses that binary as its installer.

## Consequences

Node is required for all tooling, beside Bun. A task whose command runs `bun` must list its cache inputs and outputs, or not be cached: Vite+ cannot see the files Bun reads or writes and would replay stale output. Vite+ releases about once a week, and its formatter, linter and type-checker versions move with it. Its type-checker is a beta port of TypeScript 7.1, while the libraries are built with TypeScript 7.0.2, so the two can disagree. The libraries build with `vp pack` (tsdown): one file per module, declarations, `publint` and `attw`, with Babel's `annotate-pure-calls` as a plugin, because the bundler adds no pure-call annotations and Effect's tree-shaking needs them.

Each package's `exports` also map a private `@mitome/source` condition to its `src`, which the type-checker (`customConditions`), the tests (`ssr.resolve.conditions`) and the source CLI (`bun --conditions`) follow, so an edit in one package is seen everywhere without a build and the check builds nothing. The published `exports` (`publishConfig.exports`) name only `dist`, and the CLI binary and the release tarballs still build from `dist`: they are the artifacts. Tests run as two tasks: `test`, from source with nothing built, and `test:dist`, the tests tagged `dist` because they exercise built output (a consumer's declarations, cross-process imports of `dist`, the compiled binary and its terminal, the scaffolded application, the release fixtures), after the builds they need. CI runs both.
