# Which toolchain: today's, all-in Bun, Vite+, or Node only

Question: the owner wants the repository moved to Vite+ following upstream practice, and asked whether to drop Bun for Node, or to go the other way and use Bun for everything.

Researched 2026-11-23 at stack tip `44324ea`. Four lanes: the Vite+ documentation and source at 1.7.0; real repositories that use it (the owner's `crust` first); a migration spike on a throwaway clone; and an all-in-Bun spike at Bun 1.4.5. The full reports, with every citation and command, are in `~/.local/state/mitome/mvp-stack/review/viteplus/` (`viteplus.task-1.md`, `viteplus.task-2.md`, `viteplus.task-3.da5b15cc.md` with `spike-notes.md` and `spike.patch`, `viteplus.task-4-all-bun.8f021cad.md`). The development-loop study of the same day is `dev-environment.md`.

## Short answer

Move to Vite+ and keep Bun as the package manager and as the runtime of the CLI. Do not go all-in on Bun yet, and do not drop Bun.

## The options

| Option                                                                                 | Verdict             | Why                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stay as today (Bun, turbo, oxlint, oxfmt, vitest, patched `tsc`, custom library build) | Works               | Six tools and four config files for what one tool now does; no source-first convention; the owner asked to move.                                                                                                                                                                    |
| All-in Bun                                                                             | Not yet             | At 1.4.5 only `bun fmt` is a drop-in. `bun lint` is canary only. `bun check` ignores compiler plugins, so it misses Effect mistakes. The vitest suites do not load under `bun test`, and Effect has no official integration. No task cache, no declarations, no publish provenance. |
| **Vite+, Bun kept as package manager and CLI runtime**                                 | **Recommended**     | `vp migrate` did it in 20 seconds on the clone and kept `bun.lock`, the catalog and `workspace:*`. Lint, format, type-check with Effect diagnostics, tests, the library build and the docs build all worked.                                                                        |
| Vite+ on pnpm and Node, Bun only as the CLI runtime                                    | Works, more to move | What every adopter found does, including `crust`. Costs a package-manager migration (lockfile, catalog, release packing, CI, the eight platform packages) for small gains.                                                                                                          |
| Node only                                                                              | No                  | OpenTUI needs the Bun runtime, the single binary comes from `bun build --compile`, and `mitome init` uses the binary as its installer. Vite+'s executable packing is Node-only.                                                                                                     |

## What Vite+ replaces, measured on the clone

| Job                               | Today                                    | After                                                                          | Result                                                                                                                                                                                                                 |
| --------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lint and format                   | `oxlint`, `oxfmt`, two config files each | `lint` and `fmt` blocks in the root `vite.config.ts`; `vp lint`, `vp fmt`      | Same findings on five planted problems; the project's own JS rules load unchanged. One new finding from the newer type-aware engine (an optional chain in the launcher).                                               |
| Type-check and Effect diagnostics | patched `tsc` per package                | `vp check` after `effect-tsgo patch --tsrs`                                    | Reports a planted floating Effect and an unlisted unstable import; respects `allowedUnstableApis`; five planted type errors across the packages all found. Whole repository in 3.1 to 3.3 s, format and lint included. |
| Tests                             | `vitest run` 5.1.1                       | `vp test` (bundled 5.1.0), imports from `vite-plus/test`                       | Every count unchanged. `@effect/vitest` keeps working.                                                                                                                                                                 |
| Library build                     | `tsc` plus Babel `annotate-pure-calls`   | `vp pack` (tsdown): `unbundle`, `dts`, `publint`, `attw`, `exports.devExports` | One file per module, linters pass, 1.3 s for core. Writes the `@mitome/source` export. Keeps only pure annotations already in source (28 against 51), so the Babel step must stay as a plugin or post-step.            |
| Task graph and cache              | turbo                                    | `run.tasks` in `vite.config.ts`                                                | Node tasks are tracked automatically. Tasks that run `bun` get stale cache hits unless inputs and outputs are listed by hand (measured; upstream issue vite-task#777).                                                 |
| Docs site                         | `vite build`                             | `vp build`                                                                     | Builds, 14 routes, same time. Two hand fixes after `vp migrate`.                                                                                                                                                       |

What stays, each with a reason: Bun (package manager, CLI runtime, `bun build --compile`); `bun test` for the terminal renderer and PTY suites (they need the Bun runtime); `@effect/tsgo` (the diagnostics); Babel `annotate-pure-calls` (nothing in Vite+ adds the annotations); changesets (Vite+ has no release tooling yet); mise (the local `vp` does not manage Node; the global one conflicts with mise and has NixOS gaps); wrangler.

## How the development-loop decisions land in Vite+

| Decision from `dev-environment.md`         | Shape under Vite+                                                                                                                                                                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private export condition `@mitome/source`  | `pack.exports.devExports: "@mitome/source"` generates it; `customConditions` for the checker; `ssr.resolve.conditions` for tests; `bun --conditions` for the source CLI. Measured: the source CLI and `vp check` both work with every `dist` deleted. |
| Fast tests apart from built-artifact tests | Two tasks. With no `dist`, core passes 162 of 163 and providers 448 of 452; the five failures are tests that exercise built output on purpose, and move to the artifact task with the binary and PTY suites.                                          |
| Quieter gates                              | `vp check` is one command with compact output. `vp run` has no errors-only mode yet (upstream issue #1768).                                                                                                                                           |
| Commit hook                                | `vp config` installs `.vite-hooks/pre-commit` running `vp staged`.                                                                                                                                                                                    |
| Tracked `dev/agent` Configuration          | An ordinary workspace member; nothing Vite+-specific.                                                                                                                                                                                                 |

## Risks

- **Stale cache for Bun tasks.** Every task whose command is `bun …` needs `cache.input` and `cache.output`, or `cache: false`. Easy to forget.
- **No cache shared between worktrees**, and built-in tasks miss the cache at another checkout path (upstream #3374). `vp check` at 3 s and source-first tests make this matter less than it did for turbo.
- **A beta checker.** Vite+ 1.7 type-checks with `tsrs` 7.1-beta; the repository pins TypeScript 7.0.2. One finding already differs.
- **Weekly releases.** Eight in seven weeks since 1.0; lint, format and checker versions move with them.
- **Bun as package manager is the less-travelled path.** Supported and documented, worked in the spike, but no adopter found uses it.
- **Node becomes required** beside Bun for all tooling.

## Not done in the spike

The full `turbo.json` to `run.tasks` rewrite and its timings; `vp pack` for providers and create-mitome; the release fixtures against packed output; the CLI compile as a `vp run` task; `annotate-pure-calls` as a pack plugin; `vp dev`; CI.

## All-in Bun, for the record

| Job           | Bun 1.4.5               | Measured                                                                                                          |
| ------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Format        | `bun fmt`               | Agrees with oxfmt on all 257 files; 28 ms against 371 ms.                                                         |
| Lint          | canary only             | Canary found the same six planted problems; follows an older oxlint and has no `jsdoc` rules.                     |
| Type-check    | `bun check`             | 3 to 5 times faster; reported "No type errors" on a planted floating Effect.                                      |
| Tests         | `bun test`              | Suites fail to load as they are. After a port to a one-maintainer adapter: core 163 of 163, providers 450 of 452. |
| Library build | `bun build --no-bundle` | No declarations, no pure annotations.                                                                             |
| Tasks         | `bun run --filter`      | Dependency order, no cache: 2 s every run against 0.75 s warm with turbo.                                         |

opencode, OpenTUI and Bun's own repository all lint with oxlint and type-check with `tsc` or its native preview; opencode keeps turbo.
