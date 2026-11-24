# The development loop: what it costs today and what to change

Question: should the development environment be reworked, and what is the fastest way to iterate on Mitome?

Researched 2026-11-23 at stack tip `483c85e` on the owner's machine (Ryzen 7 6800H, 16 threads, NixOS, tools through mise). Three lanes: measurements in a scratch worktree, the configuration of five reference projects (Effect, pi, eve, OpenTUI, opencode, read from local clones), and the official documentation of the pinned tools (Bun 1.4.5, TypeScript 7.0.2 with `@effect/tsgo` 0.73.2, turbo 2.11.13, vitest 5.1.1, OpenTUI 0.9.7, mise). The full lane reports, with every citation, are in `~/.local/state/mitome/mvp-stack/review/round-e/round-e.task-{4,5,6}.md`.

## Short answer

Do not rework the environment. mise plus `packageManager` plus `.node-version` already pin what a Nix flake or a container would, and the loop is fast: a clean tree reaches a working source CLI in about 2.5 seconds, and the whole CI-equivalent gate takes about 30 seconds.

What slows iteration is how the packages find each other. Every workspace package exports only its built `dist`, so an edit to the library is invisible to the providers, the CLI, the type-checker and a Configuration until a rebuild, and a missed rebuild gives a wrong result with no warning. Fix that, give the source CLI a Configuration it can load, split the slow binary tests from the fast ones, and trim what the gates print.

## What was measured

| Step                                        | Time                                                    |
| ------------------------------------------- | ------------------------------------------------------- |
| `bun install --frozen-lockfile`, warm cache | 0.55 s                                                  |
| `bun run dev:cli --help` before any build   | fails: `Cannot find module 'create-mitome/template'`    |
| build the CLI's dependencies                | 1.7 s                                                   |
| `bun run dev:cli --help`                    | 0.20 s                                                  |
| `bun run build` cold / warm                 | 5.3 s / 0.07 s (5.1 s of the cold run is the docs site) |
| `bun run check` cold / warm                 | 4.5 s / 0.3 s                                           |
| `bun run test` cold                         | 20 to 24 s                                              |
| full CI sequence, cold                      | about 28 s                                              |
| one core test file                          | 0.6 to 0.9 s                                            |
| CLI compile                                 | 0.33 s                                                  |

Where an edit to `packages/mitome/src/session/step.ts` is seen:

| Consumer                                                                          | Sees it                                                                                     |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| core's own tests                                                                  | at once (they import `src`)                                                                 |
| providers tests, `dev:cli run`, type-checks and type-aware lint of other packages | only after core's `dist` is rebuilt (0.5 s)                                                 |
| the compiled binary                                                               | does not contain `step.ts`; the Agent runs from the Configuration's own copy of the library |
| a default Configuration in `.dev-home`                                            | never (see below)                                                                           |

Other findings:

- **The sandboxed Configuration cannot run workspace code.** `dev:cli init` writes pins at `0.0.0` and installs from npm, where an earlier prototype is published at `0.0.0` under the same names. The install "succeeds" in under a second and the next command fails to load.
- **`cli#test` is the critical path of the gate** (16 to 22 s), almost all of it `binary.test.ts` (18 s, many processes). The CLI's fast tests take about 3 s.
- **Two Codex race tests slept six seconds each**, 12 of the providers suite's 14 seconds. (Replaced by explicit signals in the audit round of the same day.)
- **`bun run test` prints 3,876 lines (264 KB)** on success, mostly pack listings. With `--output-logs=errors-only` it prints 11 lines.
- **Every install marks `packages/cli/scripts/mitome.mjs` as modified** (mode 644 to 755), because it is a `bin` target stored without the executable bit.
- **The turbo cache is shared by all worktrees and has grown to about 30 GB** on a disk that is 88 % full.
- **A second Bun (1.4.4, from the Nix profile) is on PATH** outside the repository.
- Under load from parallel agents, per-task times rise two to three times and timing-bound tests occasionally time out.

## What the reference projects do

| Project  | How packages import each other in development                                                             |
| -------- | --------------------------------------------------------------------------------------------------------- |
| Effect   | `exports` point at `src`; `publishConfig.exports` swaps to `dist` on publish (a pnpm feature)             |
| opencode | `exports` point at `src`; the one published package rewrites its manifest in its publish script           |
| OpenTUI  | `exports` point at `src`; the build writes a separate manifest and publishes from `dist/`                 |
| eve      | a private export condition (`eve-source`) maps to `src`; TypeScript follows it through `customConditions` |
| pi       | `exports` point at `dist`; three hand-kept alias tables map to source                                     |

None of them hot-reloads a terminal UI. All of them keep artifact tests (binary, `dist`) out of the inner loop, keep a development Configuration or example inside the repository, and give coding agents a short list of narrow commands.

What fits Mitome: eve's private condition. Bun's `pack` ignores `publishConfig.exports` (measured), so Effect's pattern would need a manifest rewrite at release; pi's alias tables break Mitome's per-package `rootDir` (TS6059, measured).

## What the tools support

A private export condition works in every resolver Mitome uses. Verified on a clone of the real repository with every `dist/` deleted:

| Resolver                                              | How it is told                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Bun runtime, `bun test`, `bun build --compile`        | `--conditions=<name>` (or `BUN_OPTIONS`); there is no `bunfig.toml` key               |
| TypeScript 7 (the patched `tsc`)                      | `customConditions` in the tsconfig                                                    |
| vitest 5                                              | `ssr.resolve.conditions` (`resolve.conditions` has no effect in the node environment) |
| a compiled binary importing an external Configuration | `BUN_OPTIONS=--conditions=<name>` at run time                                         |

The name must be private. Bun always applies `"bun"`, and Vite applies `"development"` by default, so either would send published users to `src`, which is not shipped.

For a Configuration outside the workspace: `file:` fails on `catalog:` versions; `link:` gives two copies of Effect unless the directory sits inside the repository and declares no `effect`; a workspace member gives one copy and follows the condition.

`bun --watch` restarts the process when any imported workspace source changes. `bun --hot` does not suit a terminal UI, which owns stdin and stdout. OpenTUI has a test renderer (already used) and no hot reload.

On NixOS, nix-ld already runs the generic Bun, the compiled CLI and npm's prebuilt binaries. A flake would add two tracked files, lag the pinned Bun (nixpkgs has 1.4.4), and conflict with `effect-tsgo patch` on read-only stores.

## Options

| #   | Change                                                                                                                                                | Files                                                                                           | Buys                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Private source condition: one extra key per `exports` entry, `customConditions`, `--conditions` in `dev:cli`, `ssr.resolve.conditions` for vitest     | three `package.json`, `packages/config/tsconfig.base.json`, `scripts/dev-cli.ts`, vitest config | Edits are seen everywhere without a build; no stale or missing `dist`; `dev:cli` works on a clean checkout; fewer `^build` edges in turbo |
| 2   | A development Configuration inside the workspace, loaded by `dev:cli` by default; credentials and state stay in the git-ignored `.dev-home`           | a small tracked package, root `workspaces`, `scripts/dev-cli.ts`, `bun.lock`                    | The source CLI runs a real Agent with no install step, on the same library instance                                                       |
| 3   | Split the CLI tests: `test` (fast) and `test:binary` (compiled binary and PTY); CI runs both                                                          | `packages/cli/package.json`, `turbo.json`, CI workflow                                          | CLI inner loop from about 23 s to about 3 s                                                                                               |
| 4   | Agent hygiene: `errors-only` output for gate tasks, the executable bit on `mitome.mjs`, a short command list in `AGENTS.md`, a cap on the turbo cache | `turbo.json`, one file mode, `AGENTS.md`                                                        | 264 KB to 0.5 KB per passing test run; a clean tree after install; agents stop running full gates for one-file edits                      |
| 5   | `dev:cli --watch`                                                                                                                                     | `scripts/dev-cli.ts`                                                                            | Restart on save across workspace sources (not verified with the terminal UI)                                                              |
| 6   | Nix flake dev shell, container, Bun global store                                                                                                      | new files                                                                                       | Nothing measured                                                                                                                          |

## Recommendation

Options 1 to 4, in that order; 5 after trying it by hand; not 6.

## Decisions for the owner

- The condition's name (`@mitome/source` or `mitome-source`), and whether the published manifests may carry the key (eve ships its own; the alternative is to strip it at pack time).
- Whether the tracked development Configuration is the owner's real agent setup or a small example, with a personal copy kept untracked.
- Whether the release binary keeps bundling `dist`.

## Not verified

- Type-check time once dependencies resolve to source, and whether type-aware oxlint follows `customConditions`.
- Whether `publint` and `attw` accept a condition key that points outside `files`.
- The terminal UI under `bun --watch`.
- Timings on an idle machine: other agents were running gates during the measurements.
