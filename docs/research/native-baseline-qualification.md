# Native execution baseline qualification (#181)

Status: **the repository catalog is upgraded to Effect `4.0.0-rc.117` and Vitest `5.0.2` in this branch, and every native gate passes against the worktree-installed packages.** Isolated rc.117 qualification came first; the owner then authorized the conditional upgrade. rc.108 fails the native gates (historical sections below). The compiler and `@effect/tsgo` are unchanged, and no upstream source or package was patched. The SQL transaction gate is separate and not assessed here.

## Installed rc.117 upgrade

**Dependency delta.** In the root `package.json` catalog, exactly five entries move from `4.0.0-rc.108` to `4.0.0-rc.117`: `effect`, `@effect/ai-openai`, `@effect/ai-openai-compat`, `@effect/platform-bun` and `@effect/vitest`. `bun install --backend=copyfile` (Bun 1.4.0, worktree-local `node_modules`) updated `bun.lock`. The only lock changes are:

- the five catalog entries;
- transitive `@effect/platform-node-shared` rc.109 → rc.117;
- removal of the dependencies rc.117 `effect` no longer declares: `fast-check`, `pure-rand`, `kubernetes-types`, `msgpackr`, `msgpackr-extract` and its platform binaries, `node-gyp-build-optional-packages`, and `uuid`.

A `--frozen-lockfile` reinstall reports no changes. TypeScript 7.0.2 and `@effect/tsgo` 0.36.5 are unchanged. The worktree's patched compiler reports `Version 7.0.2+effect-tsgo.0.36.5`, and its wrapper, package metadata and native executable are byte-identical to the approved original-checkout compiler. The installed `effect` tree has no differences from the isolated rc.117 package. The original checkout, its `node_modules` and the isolated package hash-verify unchanged.

**Vitest peer fix (owner-approved sixth catalog entry).** `@effect/vitest@4.0.0-rc.117` declares peer `vitest >=5.0.0 <6.0.0`, so the catalog `vitest` moves from 4.1.11 to 5.0.2. The Node floor `^22.12.0 || ^24.0.0 || >=26.0.0` covers the repository's Node 26.7.0.

`bun install --backend=copyfile` changed only Vitest's own subtree in `bun.lock`:

- `vitest` and `@vitest/{mocker,spy}` move to 5.0.2. `@vitest/{expect,pretty-format,runner,snapshot,utils}` are removed, because Vitest 5 bundles them.
- Vitest-owned dependencies change: `es-module-lexer` 2.3.1 → 2.3.2, `tinybench` 2.9.0 → 6.2.0, `why-is-node-running` 2.3.0 → 3.2.2; `siginfo`, `stackback` and `tinyrainbow` are removed.
- Existing `picomatch` 4.0.5/4.0.7 and `magic-string` 0.30.21 entries are re-hoisted; no new versions.

No test or config migration was needed. The version-matched Vitest 5.0.2 migration guide (tag `428e2e50`) was checked against repository usage, and the repository has no Vitest config file. All suites report `RUN v5.0.2` with unchanged counts.

After a fresh worktree `node_modules` (removed, then `bun install --frozen-lockfile --backend=copyfile`), an audit of every linked peer pair (227 pairs) finds no Effect or Vitest mismatch. Two pre-existing mismatches remain, both unchanged by this work: `@opentui/solid@0.5.8` wants `solid-js` 1.9.12 but the repo pins 1.9.15, and `bun-ffi-structs@0.3.1` wants `typescript ^5` but the repo uses 7.0.2.

**Source migration** (only what the rc.108 → rc.117 delta broke):

- `effect/unstable/cli`: renamed constructors `Flag.String`, `Flag.Boolean`, `Flag.Int`, `Argument.String`, `Prompt.Select`, `Prompt.String` and `Prompt.Password`. rc.117 boolean flags fail when omitted, so `--print` and `--yes` get `Flag.withDefault(false)`, keeping rc.108 behavior (the existing CLI suite caught this: 32 failures before the fix).
- `Config.Redacted` and `Config.String` renames in providers.
- `LanguageModel.Service` is now `LanguageModel.LanguageModel`, and raw test fakes must carry `[LanguageModel.TypeId]`.
- The response part brand is now `"~effect/ai/Response/Part"` (sdk `toResponsePart` and its existing hook test).
- `SchemaGetter.transformOrFail` becomes `transformEffect` (sdk test).
- `onExcessProperty: "preserve"` was removed. `scripts/dev-cli.ts` now decodes the manifest with `Schema.StructWithRest(…, [Schema.Record(Schema.String, Schema.Unknown)])`, so rewriting `.dev-home/package.json` still keeps undeclared fields. An evidence-only check confirms field preservation and dependency validation.
- `Socket.layerWebSocketConstructorGlobal` now rejects constructor options. The OpenAI WebSocket transport provides its own `Socket.WebSocketConstructor`, which forwards only the declared `headers` option to the Node/Bun global, with no cast. The existing test asserting the `Authorization` handshake header caught this.
- Upstream `@effect/ai-openai` rc.117 sends string Tool results unquoted in `function_call_output`. Two existing assertions are updated from `'"hello"'` to `"hello"`.
- The `create-mitome` Effect template pin moves to `4.0.0-rc.117`, enforced by its existing catalog-sync test.

**Release metadata.** `.changeset/effect-rc117-pin.md` follows the existing prerelease convention (minor for breaking library changes, patch for scaffold changes; one fixed release group). It marks core, sdk, providers, channels and tui as minor and `create-mitome` as patch. It tells Effect users to move their own `effect` to `4.0.0-rc.117`. Read-only `changeset status --verbose` exits 0. No version, release or publish command was run.

No test was deleted and no new repository test was needed: every migration failure was caught by an existing type check or test. The TODO-marked `handleDeclared` helper remains in the qualification fixture only; production code uses no wrapper.

**Repository gates** (logs under `181-upgrade-evidence/logs/`):

| Gate                                                                     | rc.108 baseline (same worktree, before)                 | rc.117 after migration   |
| ------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------ |
| `bun run check -- --force --continue` (lint, fmt, types)                 | exit 1: only `//#lint:root` on the rc.117-only fixture  | exit 0, 27/27 tasks      |
| `bun run test -- --force --continue`                                     | exit 0; 13/19/91/154/66/70 Vitest, 5 + 26 + 8 Bun tests | exit 0; identical counts |
| `bun run build -- --force --continue`                                    | exit 0                                                  | exit 0, 9/9 tasks        |
| CI `bunx turbo run lint //#fmt check:types //#check:types build --force` | not run                                                 | exit 0, 28/28 tasks      |
| `bun run build:docs -- --force`                                          | not run                                                 | exit 0                   |
| `bun install --frozen-lockfile`                                          | exit 0                                                  | exit 0, no changes       |

After the Vitest fix and a fresh frozen install (logs in `181-vitest-evidence/logs/`), every gate exits 0 again:

- `bun run check -- --force --continue`: 27/27 tasks.
- `bun run test -- --force --continue`: 17/17 tasks, with the same counts.
- `bun run build -- --force --continue`: 9/9 tasks.
- CI `bunx turbo run lint //#fmt check:types //#check:types build --force`: 28/28 tasks.
- CI `bun run test -- --force`: 17/17 tasks.
- `bun run build:docs -- --force`: 5/5 tasks.
- `bun install --frozen-lockfile`: no changes.

The worktree compiler is again byte-identical to the approved compiler.

`packages/cli` `build:release` (eight cross-compiled binaries) and native-platform runs were not executed.

**Installed-baseline qualification.** Evidence `181-upgrade-evidence/logs/run-RA9atPYv`: 24 desired gates pass, 0 `QUALIFICATION-RED`, and 86 control/pin/count expectations match. An independent `sha256sum -c` of its 83-file `evidence.sha256` exits 0.

- Retained suites run from **import-only copies**. Of 51 files, 33 are byte-identical and 18 only have their absolute `/tmp/…` imports rewritten; no API change.
- `effect` resolves to the worktree-installed package in all nine copied directories, the repository fixture and every workspace package. Effect compiler inputs come only from that package: 155 for the kernel, 214 for the others.
- The fixture runs from a copy beside the worktree `node_modules`.
- Exact-optional variants override `typeRoots` to the worktree. As-is retained configs still name the original checkout's `@types` directory (same `@types/bun` 1.4.0, read-only).
- Results equal the isolated run (below): the same check counts, negatives, mutants and pinned #8526/#8527 counterexamples.
- The earlier in-place isolated runs (`run-GGdyVkOD`) remain separate evidence and are not installed-baseline results.

**Final installed-baseline run (after the Vitest fix).** Evidence `181-vitest-evidence/logs/run-V96qhIU5`: 26 desired gates pass, 0 `QUALIFICATION-RED`, and 101 control/pin/count expectations match. An independent `sha256sum -c` of its 95-file `evidence.sha256` exits 0. It repeats R1–R5 above unchanged, and adds:

- **Peer audit:** no Effect or Vitest mismatch; only the two pre-existing mismatches above.
- **Superseded upgrade manifest:** the upgrade-stage source manifest fails for `package.json` and `bun.lock`, as expected, and is preserved rather than regenerated. **Correction:** this control counted only `: FAILED` lines. It did not notice 96 further `FAILED open or read` entries: the `@effect/vitest` rc.117 package-store variant `+a8056e89…`, which Bun re-keyed to `+de7e7c18…` when Vitest changed. The final verification revision below checks those entries strictly.
- **R6, Bun WebSocket transport.** The existing `uses one Responses WebSocket by default for Tool continuations` test runs under `bun --bun vitest`.
  - An evidence-only setup file asserts that test code runs in Bun 1.4.0.
  - It passes. The Bun branch selects the WebSocket transport, the changed `Socket.WebSocketConstructor` hands `headers` to Bun's global `WebSocket`, and the local `ws` server receives `Authorization: Bearer synthetic-key`. There is one upgrade and no HTTP request, and the string result is unquoted.
  - A mutant that restores `Socket.layerWebSocketConstructorGlobal` fails on Bun with `TypeError: WebSocket client options are not supported by the global WebSocket constructor`.
  - The same test still passes on Node v26.7.0.
- **Limits of R6:** it uses a local `ws` server and a synthetic key, with no real Provider traffic. The Bun run is evidence-only and not part of the repository's `test` script, whose Vitest suites run on Node.

**Final verification revision (after the review fixes).** Evidence `181-final-evidence/logs/run-UZ04DtuG`: 26 desired gates pass, 0 `QUALIFICATION-RED`, and 110 control/pin/count expectations match. An independent `sha256sum -c` of its 104-file `evidence.sha256` exits 0.

- **Why a new revision:** the review fix replaced the fixture's `Inner<T>` helper with the installed `Effect.Success`. The unchanged exact assertions still pass, the unsuppressed copy has the same 11 intended diagnostics, and the 9 runtime checks pass. Also, rerunning `181-vitest-evidence/run.sh` at the committed head exits 1 at `upgrade-evidence-run` (parent run `181-vitest-evidence/logs/run-18Tr7RLb`, preserved): the upgrade-stage `post-run.sha256` hashes this document, which later stages intentionally updated.
- **How historical manifests are verified:** none is rewritten. `checks/verify-manifest.py` requires every entry to match its live file, except explicitly declared supersessions. For a declared superseded path, the recorded historical hash must equal a retained snapshot's bytes.
  - This document at the upgrade stage (`b06fc9fc…`, reconstructed and hash-verified) and at the Vitest stage (`16d4c707…`).
  - The rc.117-stage fixture `types.ts` (`f9d7e8c5…`).
  - The pre-Vitest `package.json` and `bun.lock` retained in `181-vitest-evidence/provenance/`.
  - The 96 re-keyed `@effect/vitest` store entries are verified against the same relative paths in the new store variant, where all recorded hashes match.
  - Controls pin that the upgrade-stage manifest still fails on this document without a declaration, and that a wrong snapshot is rejected.
- **What this runner does not hash:** the live qualification document. Its source manifest covers the current fixture and the runner files, so this citation cannot invalidate the run.

**Runner v2 (exit-status correction).** Review found that `run.sh` recorded a failed desired gate as `QUALIFICATION-RED` but still exited 0, because its final exit tested only control mismatches. `run-UZ04DtuG` itself recorded all 26 desired gates passing, so its result stands, but its exit status alone was not a reliable verdict. `run.sh` and its manifests are kept unchanged. `run-v2.sh` differs only in the following ways:

- a desired mismatch also sets a failure flag;
- `QUALIFICATION VERDICT: GREEN` or `FAILED (…)` is written to `summary.log` before hashing, and the run exits 1 unless the verdict is GREEN;
- it verifies its own `provenance/sources-v2.sha256`, which covers the current fixture, both runners, both `hash-sources` scripts, the checks, the negative-injection files and the original `sources.sha256` and `snapshots.sha256`.

Two runs recorded the change:

- **Positive, `logs/run-QwsFG9jE`:** exit 0 and verdict GREEN. 26/26 desired gates pass, 0 RED, and 110 controls match. An independent `sha256sum -c` of its 104-file evidence exits 0.
- **Negative, `logs/negative-nECfbAzf`:** `negative/make-injected.sh` derives `negative/run-v2-injected.sh` with exactly two changes. It pins the evidence root, and it replaces the desired `kernel-boundary-turn` command, which has no companion output pin, with `exit 7`. Nothing installed, retained or in the repository fixture is modified. The run exits 1 with exactly one `QUALIFICATION-RED` (`kernel-boundary-turn`, actual 7). The other 25 desired gates and all 110 controls match, and the verdict is `FAILED (controls_bad=0 desired_red=1)`. An independent evidence check exits 0.

## rc.117 isolated qualification (before the upgrade)

**Candidate.** `effect@4.0.0-rc.117`, isolated at `/tmp/mitome-sql-transaction-proof-rc117-20260924/node_modules/effect`. Its tarball SHA-512 equals the npm registry `dist.integrity` (`sha512-UUyi9QiO…j/w==`), and the extracted tree has no differences from the isolated package. Git tag `effect@4.0.0-rc.117` (`14a3f140`) sources for `Toolkit.ts`, `LanguageModel.ts` and `Response.ts` are byte-identical to the package. `Tool.ts` differs only in JSDoc placement and formatting of one `Tool.dynamic` overload.

**Upstream fixes, verified from source rather than issue state.** Both fixes merged to `main` **after** rc.117; no Effect release contains them yet (rc.117 is the latest tag):

- #8526 (outer `handle` omits decoder services) closed by PR #8531, merge commit `1f760401`, 119 commits ahead of the rc.117 tag. The only source change adds `Tool.HandlerServices` as the outer Effect's requirement.
- #8527 (return-mode Stream declares no errors) closed by PR #8530, merge commit `cf7cfd61`, 120 commits ahead. The only source change adds `AiError.AiError` to the Stream error.

Both are declaration-only changes to `Toolkit.WithHandler.handle`; runtime is unchanged. rc.117 therefore still has both declaration defects, and the retained `native-only.ts` and the new fixture pin them. Mitome's controlled seam provides services around the whole outer Effect plus Stream drain. Its flattened A/E/R is already truthful (the whole operation includes `Decoder` in R and `AiError` in E), so **no workaround is needed for native qualification**. A widening-only candidate, `handleDeclared` in the fixture, is compile- and runtime-checked. It has an inline `TODO(effect-upgrade)` removal condition naming PRs #8530/#8531, and is used only by the phase-split controls. No package patch was needed.

**Results.** Evidence `run-GGdyVkOD` (see Reproduce): 24 desired gates pass, 0 `QUALIFICATION-RED`, and 93 control/pin/count expectations match. All retained suites ran **unmodified, in place**, and their trees hash-verified before and after.

- **Native ownership kernel:** strict and exact compiles (155 Effect inputs, all rc.117); `checks.ts` (14 checks), `owned-checks.ts` (7), `qualification-checks.ts` (4), both boundary modes and both observer modes all exit 0. The Turn/Session mutants exit 1, the negatives report 3 diagnostics as-is and with exact optional properties, and `never-save.ts` exits 124 (a preserved limitation).
- **Tool boundary:** as-is and exact compiles; 21 checks. Negatives report 8 as-is and 8 exact, and the order mutant exits 1. The two consumer-exit counterexamples (`EXPECT_CLEANUP`) still exit 1 by design; the joined-owner arrangement settles, per the ownership reassessment.
- **`native-only.ts`:** as-is and exact compiles. Runtime exit 0 pins the #8526 and #8527 counterexamples and all six ownership arrangements.
- **Application → Session/Turn + native Toolkit:** as-is and exact compiles; 26 integrated checks. The ownership control passes, the owner and history mutants exit 1 at their assertions, and the negatives report 9 as-is and 9 exact.
- **Nested child Turn owner:** compile with exact optional properties in its own config; 7 checks and 5 owner groups. `repro.ts` prints `{"first":"grandchild-cleanup","childHasOwnOwner":true,"saves":[]}`. Four mutants, the original challenge and both no-rebind mutants exit 1 at their intended assertions. Negatives report 15, and owner negatives 6.
- **New fixture (rc.117 variant):** compiles; 214 Effect inputs, all rc.117. 26 exact assertions; the unsuppressed copy has exactly 11 intended diagnostics. Nine runtime checks pass, covering:
  - a transforming, serviceful input schema decoded once through a full outer `handle` + drain;
  - disabled resolution returning **encoded** params with no undeclared `Decoder`;
  - controlled dispatch of the generated call running the handler once;
  - error mode and return mode (with `failureOrigin: "handler"`);
  - fallible acquisition unwinding with no handler entry;
  - the native #8526 defect, which compiles but defects on Stream-only provision;
  - the workaround decoding in the outer phase.

The three rc.108 blockers below are resolved on rc.117 by unmodified native code. rc.108's fixture and results are preserved outside the repository at `181-rc117-evidence/preserved-rc108/`; the repository fixture is now the rc.117 variant.

The dependency delta proposed here was subsequently applied (see Installed rc.117 upgrade).

## Versions and provenance (rc.108 run)

| Item      | Value                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Compiler  | `bun /home/cyan/dev/github.com/chenxin-yan/mitome/node_modules/typescript/bin/tsc`, `Version 7.0.2+effect-tsgo.0.36.5` (`@effect/tsgo` 0.36.5) |
| Installed | `effect@4.0.0-rc.108`, the repository catalog pin, `node_modules/.bun/effect@4.0.0-rc.108`                                                     |
| Candidate | Isolated `effect@4.0.0-rc.117` at `/tmp/mitome-sql-transaction-proof-rc117-20260924/node_modules/effect`                                       |
| Runtime   | Bun 1.4.0 on Linux x64 (Node v26.7.0 present, not exercised)                                                                                   |
| Base/head | `0064d6745f276d8e2e895d0ffdc282d13e70d562`                                                                                                     |

SHA-256 of the consumed rc.108 sources: `Tool.ts` `52daf26b…8277`, `Toolkit.ts` `d60336f9…e764`, `LanguageModel.ts` `fefe0907…022c`, `Response.ts` `6bbc5f2e…9e2c`, `package.json` `1ab5b287…0ed2`. The compiler wrapper is `2219f428…2ffd` and its native executable is `6c178f41…f6ad`. Full hashes for 187 compiler, Effect rc.108/rc.117, retained-proof, fixture and runner files are recorded in `provenance/sources-v2.sha256` and were verified before and after the cited run. The 183-entry `provenance/sources.sha256` is kept unchanged for the historical run (see Reproduce).

## Method (rc.108 run)

- **Compiler settings.** Every configuration uses `strict`, `noUncheckedIndexedAccess` and `skipLibCheck`. Only some use `exactOptionalPropertyTypes`:
  - Already exact in their own configuration: the new fixture (positive, negative and `--skipLibCheck false` runs), and the retained child owner-fix suite (compile and owner negatives, on both rc.108 and rc.117).
  - Retained configurations without exact optional properties were compiled **as-is**, and some also through an extending exact variant under the evidence `configs/`:
    - v2 proof: positive and negative, both as-is and exact.
    - Native kernel: positive as-is and exact; negative as-is only.
    - Integrated suite: positive as-is and exact on rc.108; exact only on rc.117.
    - rc.117 kernel: positive as-is and exact.
  - Compiled as-is only, never with exact optional properties: the tool-boundary suite and `native-only.ts`. Both are red on rc.108 anyway.
  - Exact variants that exist under `configs/` but were not run: kernel negative, tool-boundary positive and negative, `native-only`, integrated negative.
- **`skipLibCheck`** makes this consumer-contract evidence only, not an upstream source build. With `--skipLibCheck false`, the new fixture reports only seven DOM-global declaration errors (`TextDecoderOptions`, `Transferable`) caused by `lib: ESNext`.
- **Retained rc.108 proof.** `/tmp/mitome-session-turn-proof-rc108-20260924/v2` was rerun in place and read-only.
- **Retained rc.117 proofs.** Copies of 51 files were made under the evidence `transplant/`, resolving `effect` to rc.108: 31 are byte-identical, 18 change only absolute import paths, and 2 also rename the rc.117 getter `SchemaGetter.transformEffect` to rc.108's `transformOrFail`, whose signature is the same. The deltas are recorded in `provenance/transplant-import-delta.diff`. Runtime and compiler inputs were verified to resolve only to rc.108.
- **New coverage.** The only new controls are `tools/qualification/native-baseline/`. `types.ts` holds compile-only exact A/E/R assertions, `checks.ts` holds runtime observations, and `EXPECT=desired-*` runs assert the required behavior instead.
- **Plugin caveat.** The fixture's `tsconfig.json` omits the repository base configuration's `@effect/language-service` plugin. Its diagnostics (for example `effect(missingEffectContext)`) are not suppressed by `@ts-expect-error`, so they would break the intended-rejection controls. The approved patched compiler still does all type checking, but Effect language-service diagnostics are **not** part of this evidence. With the plugin enabled, a development compile also reported `effect(schemaNumber)` suggestions for the fixture's `Schema.Number` fields.

## Historical results on rc.108

This section describes the rc.108 fixture, which is preserved at `181-rc117-evidence/preserved-rc108/native-baseline/`, not the current repository fixture.

**Retained v2 ownership proof** (compensated kernel with manual Scope/Cause handling and `Fiber.await`), all as recorded:

- Strict and exact-optional compilation: exit 0.
- `checks.ts`, `owned-checks.ts` and both `boundary-controls.ts` modes: exit 0.
- Observer `await`: exit 0. Observer `join`: exit 124, as recorded.
- Both ownership mutants: exit 1.
- Negative compilation: three TS2322 diagnostics, or three TS2375 diagnostics under exact optional properties.
- `never-save.ts`: exit 124.

These results rely on rc.108-specific compensations, so they do not qualify native ownership.

**Unchanged native ownership kernel** (rc.117 source using `Effect.scopedWith` and `Fiber.join`) — **red**:

- Strict and exact-optional compilation pass, but that is type evidence only.
- `checks.ts` and `boundary-controls.ts turn` pass.
- `owned-checks.ts` exits 1 at `:77`: a Turn cleanup defect loses the body failure.
- `qualification-checks.ts` exits 1 at `:46`: the body failure is missing from the admitted Exit under cancellation.
- `boundary-controls.ts session` and `observer-regression.ts join` hang with exit 124.

This matches v2's recorded reasons for its compensations and the `Fiber.join` observer regression (Effect #7338, fixed by #7344 after rc.108). The gate was stopped here and no compensation was reintroduced.

**Native Tool declarations** — **red for transforming or serviceful input schemas**:

- rc.108 `Toolkit.WithHandler.handle` types `params` as decoded `Tool.Parameters` (`Toolkit.ts:203–223`) but decodes them at runtime (`Toolkit.ts:297`). Encoded wire values are rejected by the compiler: 13 TS2322 diagnostics in the tool-boundary suite, `native-only.ts(17,38)` and the new fixture's intended rejection. Passing encoded values would need a cast.
- With `disableToolCallResolution`, rc.108 decodes tool-call parameters while building the response (`LanguageModel.ts:1175–1178`, `Response.ts:276`). A well-typed dispatch then decodes a second time and fails with `Invalid parameters for tool 'Convert': Expected string`.
- The same decode needs the parameter-decoding service at runtime but declares only `LanguageModel` in R, so it dies with `Service not found: native-baseline/Decoder`. Both desired-behavior controls exit 1.
- rc.117 source uses encoded parameters and `ParametersEncoded` for this path. That is a source observation only; no rc.117 fixture targets this exact case.

**Native Tool behavior that holds on rc.108** (new fixture unless noted):

- Serviceful output encoding: `encodedResult` is rendered by the `Encoder` service.
- Declared handler dependency: the handler receives the invocation `Invocation` service.
- Full outer `handle` plus Stream drain.
- Error mode keeps a typed failure; return mode reports a failure value, not success.
- Fallible `toLayer` acquisition fails with `BuildFailed` after its acquired resource is released, and no handler runs.
- There are 16 exact type assertions, including handler services, result-encoding services, handler errors and Layer A/E/R. Nine intended diagnostics cover seven erasure rejections plus Equal superset/subset controls.
- Retained `native-only.ts` runtime, from the copy with the getter rename, passes. Outer decoder provision is needed; the return-mode inner `ToolResultEncodingError` is still undeclared (upstream #8526/#8527). In all six ownership arrangements, only the joined owner settles cleanup.

**Application → Session/Turn with native Toolkit** (retained integrated suite) — **red**:

- Compilation fails with four parameter-typing diagnostics.
- `checks.ts` fails on the double-decode above.
- The ownership control passes when given encoded parameters directly. The owner and history-publication mutants fail at their intended assertions.

**Nested child Turn owner** (retained owner-fix suite):

- `owner-checks.ts` runs five groups and passes. `repro.ts` prints `{"first":"grandchild-cleanup","childHasOwnOwner":true,"saves":[]}`.
- `owner-types.ts` reports no diagnostics within the child compile, which fails only at `checks.ts(157,40)`. The owner negative compile has exactly six intended diagnostics. The original challenge and the no-rebind `repro.ts` mutant fail as recorded.
- **Red:** the no-rebind `owner-checks.ts` mutant hangs with exit 124 on rc.108, instead of failing at its assertion as it does on rc.117. It hung the same way on two separate reruns.
- `checks.ts` fails for two reasons: it type-checks against rc.117's `HandlerResult.failureOrigin`, and rc.108 fails the outer `handle` for invalid return-mode parameters instead of returning a failure value.

## rc.108 blockers (resolved on rc.117 by unmodified native code, except item 4)

1. rc.108 native ownership: cleanup-failure cause loss and `Fiber.join` hangs require obsolete compensations.
2. rc.108 transforming or serviceful Tool input parameters: `handle` parameter typing, double decode after disabled resolution, and an undeclared runtime decoding service.
3. rc.108 nested-owner mutation control hangs instead of failing at its assertion; the cause was not analysed.
4. Upstream #8526/#8527 declaration mismatches remain in rc.117. They are fixed on `main` by PRs #8531/#8530 but not released; the native whole-operation seam is unaffected.

## Limits

Bun 1.4.0 and Node 26.7.0 on Linux x64 only; no Node 24 floor, macOS or Windows run. The storage, Provider and Model are fakes, with no real storage, HTTP, TUI, Provider or native-platform check. Compile-only type evidence is not runtime evidence. These results make no public-export, durability or machine-failure claim. The isolated rc.117 result does not qualify Mitome's exported surface or the non-core `@effect/*` packages, and the SQL gate is out of scope. The fixture omits the Effect language-service plugin, so its diagnostics are not evidence.

## Reproduce

**Final verification revision (current).** Evidence lives in `/home/cyan/.local/state/mitome/effect-native-stack/181-final-evidence/`. It needs the worktree `node_modules` from `bun install --frozen-lockfile --backend=copyfile`. Rerun:

```sh
bash /home/cyan/.local/state/mitome/effect-native-stack/181-final-evidence/run-v2.sh
```

It writes a fresh `logs/run-*`, self-verifies `evidence.sha256`, and exits nonzero on any desired-gate, control or evidence mismatch. The cited run is `logs/run-QwsFG9jE`: `summary.log` SHA-256 is `7639cb8f…61e3`, and `evidence.sha256` SHA-256 is `683f25b7…469f`. The earlier `run.sh` run `logs/run-UZ04DtuG` (`00a21ee9…de16` / `c69aeb8a…ca57`) is retained, with the exit-status caveat above.

The manifests are classified as follows:

- `provenance/snapshots.sha256`: the three retained historical snapshots. Verified by the run.
- `provenance/sources-v2.sha256`: the current fixture files, both runners and `hash-sources` scripts, the checks, the negative-injection files, and the original `sources.sha256` and `snapshots.sha256`. `run-v2.sh` verifies it before and after the run. The original `provenance/sources.sha256` is kept for `run.sh`.
- The upgrade, Vitest and rc.117-stage manifests: historical. Verified with declared supersessions only.
- `provenance/current-doc-v2.sha256` (previous revision: `current-doc.sha256`): records this document's final bytes after the citation. It is not an input to the run.

**Installed rc.117 + Vitest 5.0.2 (`run-V96qhIU5`, historical).** Its runner now exits 1 at `upgrade-evidence-run` for the superseded document, as described above. Evidence lives in `/home/cyan/.local/state/mitome/effect-native-stack/181-vitest-evidence/`. `bash run.sh` reuses the upgrade-stage transplant copies, configs and resolution check read-only. It verifies its own `provenance/sources.sha256`, which has 3,441 entries covering the installed Effect and Vitest package trees, lockfile, changeset, changed repository files, fixture, runner, checks and the R6 mutant. The cited run is `logs/run-V96qhIU5`: `summary.log` SHA-256 is `e8dbb01f…ff64`, and `evidence.sha256` SHA-256 is `9095f368…cd10`.

**Installed rc.117, before the Vitest fix.** Evidence lives in `/home/cyan/.local/state/mitome/effect-native-stack/181-upgrade-evidence/`. `bash run.sh` writes a fresh `logs/run-*`, self-verifies, and exits nonzero on a mismatch. It needs the worktree `node_modules` from `bun install --frozen-lockfile --backend=copyfile`. It verifies `provenance/sources.sha256` (3,306 entries: the installed Effect-family package trees, lockfile, changed repository files, fixture and runner files), `provenance/approved-compiler.sha256`, the retained trees and the prior rc.117 and rc.108 evidence, before and after.

- Cited run: `logs/run-RA9atPYv`. `summary.log` SHA-256 is `76449776…af4d`; `evidence.sha256` SHA-256 is `a39e306d…b45c`.

**Isolated rc.117 (pre-upgrade).** Evidence lives in `/home/cyan/.local/state/mitome/effect-native-stack/181-rc117-evidence/`. `bash run.sh` writes a fresh `logs/run-*`, writes the closing lines before hashing, self-verifies `evidence.sha256`, and exits nonzero on a mismatch. It verifies `provenance/sources.sha256` (2,587 entries: compiler, the whole isolated rc.117 package, upstream sources, fixture and runner files), the retained rc.117 trees (631 files), the preserved rc.108 fixture and the full rc.108 evidence tree (485 files) before and after.

- Cited run: `logs/run-GGdyVkOD`. `summary.log` SHA-256 is `7ec8f154…bc95`; `evidence.sha256` SHA-256 is `554ffa4c…56e7` and covers 90 files.
- An independent `sha256sum -c` exits 0.
- The run left the repository unchanged and staged no files.

Standalone rc.117 fixture reproduction, validated in `logs/standalone-54kw/rc117.sh`:

```sh
W=/home/cyan/dev/worktrees/mitome-effect-native/181
M=/home/cyan/dev/github.com/chenxin-yan/mitome
TSC=$M/node_modules/typescript/bin/tsc
D=$(mktemp -d)
mkdir "$D/native-baseline" "$D/node_modules" && cp "$W"/tools/qualification/native-baseline/* "$D/native-baseline/"
ln -s /tmp/mitome-sql-transaction-proof-rc117-20260924/node_modules/effect "$D/node_modules/effect"
ln -s "$M/node_modules/@types" "$D/node_modules/@types"
cd "$D/native-baseline"
bun "$TSC" -p tsconfig.json                         # exit 0
sed -E '/@ts-expect-error/d' types.ts > negative.ts
printf '{"extends":"./tsconfig.json","files":["fixture.ts","negative.ts"]}\n' > tsconfig-negative.json
bun "$TSC" -p tsconfig-negative.json                # exit 1, eleven negative.ts diagnostics
bun checks.ts                                       # exit 0, nine PASS lines
```

**rc.108 (historical).** Evidence lives in `/home/cyan/.local/state/mitome/effect-native-stack/181-evidence/`. `bash run-v2.sh` writes a fresh `logs/run-*`, verifies its own `evidence.sha256` with `sha256sum -c`, and exits nonzero on a control or evidence mismatch.

**Cited run: `logs/run-kS4f2G7V`.**

- `summary.log` SHA-256 is `4aeb0a27…3991`; `evidence.sha256` SHA-256 is `e2fe628c…5cca` and covers 85 files.
- An independent `sha256sum -c logs/run-kS4f2G7V/evidence.sha256` exits 0.
- The run matched all 63 control, pin and count expectations, with no mismatch.
- It recorded 15 desired gates as `QUALIFICATION-RED`; every verdict matches the historical run.
- It left the repository unchanged and staged no files.

**Historical run: `logs/run-I3U6mZiA`, produced by the unchanged `run.sh`.** That runner hashed `summary.log` before appending its last two lines (`QUALIFICATION-RED gates: 15` and `ALL CONTROLS MATCH`). Its `evidence.sha256` therefore fails only for `summary.log`; every other record matches. The run and its hashes are preserved unrepaired. `run-v2.sh` differs only in:

- writing those closing lines before hashing, then self-verifying;
- using `provenance/sources-v2.sha256`.

Development runs remain under `logs/dev-*`.

**Standalone rc.108 fixture reproduction.** The repository fixture is now the rc.117 variant, so copy the preserved rc.108 fixture (read-only; make the copy writable) next to a link to the original checkout's modules. `run-v2.sh` copies from the repository path, so rerunning it requires restoring the preserved files there first.

```sh
M=/home/cyan/dev/github.com/chenxin-yan/mitome
TSC=$M/node_modules/typescript/bin/tsc
D=$(mktemp -d)
P=/home/cyan/.local/state/mitome/effect-native-stack/181-rc117-evidence/preserved-rc108/native-baseline
mkdir "$D/native-baseline" && cp "$P"/* "$D/native-baseline/" && chmod u+w "$D"/native-baseline/*
ln -s "$M/node_modules" "$D/node_modules"
cd "$D/native-baseline"
bun "$TSC" -p tsconfig.json                         # exit 0
sed -E '/@ts-expect-error/d' types.ts > negative.ts
printf '{"extends":"./tsconfig.json","files":["fixture.ts","negative.ts"]}\n' > tsconfig-negative.json
bun "$TSC" -p tsconfig-negative.json                # exit 1, nine negative.ts diagnostics
bun checks.ts                                       # exit 0, seven PASS lines
EXPECT=desired-dispatch bun checks.ts               # exit 1 on rc.108 (desired red)
EXPECT=desired-generate bun checks.ts               # exit 1 on rc.108 (desired red)
```

These commands were validated against the repository copy in `181-evidence/logs/standalone-fixture-Zs5a/`, and against the preserved copy in `181-rc117-evidence/logs/standalone-54kw/rc108-preserved.sh`.
