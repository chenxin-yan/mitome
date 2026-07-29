# Architecture deepening plan

Deepen five seams surfaced by the 2026-07-29 architecture review and close two
findings with tests only. Four independent tracks; within a track, phases are
sequential (one writer per package). Every phase ends green through
`bun run check && bun run test` before the next starts.

Executor notes:

- Before writing any Effect code, run
  `effect-solutions show services-and-layers error-handling testing` — this repo is on
  effect 4.x beta; service definitions use `ServiceMap.Key`, not v3 `Context.Tag` idioms.
  Check existing service definitions in the repo first and match their style.
- Vocabulary is binding: use CONTEXT.md terms (Session, Turn, Step, Tool Call,
  Approval, Host, Child Host, Prompter, Credential) in code comments, test names, and
  commit messages. The three newest terms (Child Host, Prompter, Tool Call) were added
  to CONTEXT.md by this review.
- No public-surface changes anywhere in this plan. `Session`, `TurnEvent`, the SDK
  root, and `@mitome/sdk/effect` keep their exact shapes (ADR-0015/0022). All new
  seams are package-internal.

## Decisions (locked)

- **D1 — CLI seam shape**: `ChildHost` and `Prompter` become Effect services;
  command handlers return `Effect<ExitCode, CliError, ChildHost | Prompter | ...>`.
  Only `index.ts` (production adapter) maps the result onto `process.exitCode` and
  provides the Bun layers. No other capabilities become services: config directory
  is controlled via `MITOME_HOME` (ADR-0030), filesystem via temp dirs in tests.
- **D2 — CLI service roster**: `ChildHost` wraps the four `Bun.spawn` operations in
  `child-host.ts` (`runHost`, `install`, `inspectProviderAuthentication`,
  `runOAuthAuth`). `Prompter` wraps interactive terminal input used by init/auth
  (currently Effect `Prompt` + module-global stdin state in `support.ts`). Both are
  package-internal — nothing new is exported from `@mitome/cli`.
- **D3 — CLI spawn suite**: after the seam exists, `cli.test.ts` keeps only a
  boundary smoke set: binary boots + `--version`, `BUN_BE_BUN` re-exec, `--env-file`
  loading in the child, SIGINT forwarding, one installer round-trip, one end-to-end
  run. Everything else (definition selection, model choice, auth branching, exit
  codes, scaffold decisions) moves to in-process tests against fake
  `ChildHost`/`Prompter` layers.
- **D4 — ToolExecution scope**: merge `packages/core/src/session/toolkit.ts` and
  `approval.ts` into one internal module `tool-execution.ts` owning the whole Tool
  Call pipeline: prepare (input validation + pre-Tool veto) → gate (needsApproval +
  Approval decision protocol) → execute → post-Tool transform → result revalidation.
  The Approval protocol (pending correlation, resolve, duplicate-decision guard,
  discard-on-deny, reset) is its internal decision gate with an explicit interface
  (`request → Failure | Veto | Pending`, `resolve(id, decision)`, `reset`).
  Kills the `preparedByCallId` hand-off between two files and the
  `compiled.tools.get(name)!` by-name re-joins. ADR-0005 serialization semantics
  (`concurrency: 1`) are preserved unchanged.
- **D5 — TurnEvent unchanged**: the public `approval-required` event keeps its
  `approve()`/`deny()` Effect closures. `session.ts` adapts the pipeline's Pending
  outcome to that event in exactly one place. No SDK or Host migration.
- **D6 — Session internal seams**: extract from `session.ts` into core-internal
  modules: `model-resolver.ts` (`resolve(qualifiedId) → RuntimeModel`; parse, Provider
  lookup, provision, cache keyed by qualified-id string, Scope lifetime, TurnError
  translation) and `step-runner.ts` (recursive Step execution, model part →
  `TurnEvent` translation, Approval decision accumulation, next-prompt construction),
  consuming ToolExecution. Turn orchestration (busy/released guards, Turn Hooks,
  history commit, reset) stays in `session.ts` — it is the Session. `hooks.ts` keeps
  its shape and gains direct contract tests. Nothing new exported from core's
  `index.ts`.
- **D7 — Scaffold plan**: grow `create-mitome/src/template.ts` from source strings
  into plan + writer: `FileMap = ReadonlyMap<path, contents>`; `defaultAgentPlan`
  (CLI's `index.ts` + `AGENTS.md` + `package.json`) and `projectPlan` (those plus
  `instructions.md`, `tsconfig.json`, `README.md`); one `writeScaffold(dir, plan)`
  with a single ensure-empty semantic (fail listing the existing file before any
  write). CLI init and create-mitome both consume it. Installer remains a separate
  Host step in the CLI.
- **D8 — Deliberate scaffold divergences (keep, as plan data)**: AGENTS.md +
  discovery for the default Agent vs `instructions.md` for projects (ADR-0023/0025);
  tsconfig/README project-only; CLI init is promise-flavor-only while create-mitome
  asks. The differing clobber-check styles (`stat` loop vs `existsSync`) are drift —
  unified inside `writeScaffold`.
- **D9 — Shared selection policy**: provider choice list, model-choice construction
  (known ids + custom-model escape), and trim/non-empty validation become pure
  data/functions in create-mitome next to the plans. CLI keeps Effect Prompt (via
  `Prompter`), create-mitome keeps readline; model id sources stay as-is (CLI:
  models.dev catalog fetch with fallback; create-mitome: baked hints, ADR-0028).
- **D10 — Codex seams**: `CredentialStore` becomes an Effect service with two
  adapters (fs-backed production adapter wrapping today's
  `loadCredential`/`refreshCredential`; in-memory fake for tests).
  `codexLayer` provides `FetchHttpClient.layer` via `Layer.provideMerge` (overridable)
  instead of hardwired `Layer.provide`. `transport.streamText` requires
  `HttpClient | CredentialStore` from context instead of taking `configDirectory` and
  hitting disk. Clock and session-id randomness stay concrete — no seams without a
  failing test they enable.
- **D11 — Codex tests**: 401-refresh-retry, expiry refresh, error-body translation,
  and header construction move to stubbed `HttpClient` + in-memory `CredentialStore`.
  Keep 2–3 server tests: real SSE byte streaming end-to-end and one full refresh
  round-trip over real HTTP.
- **D12 — generateText**: untouched. Add a `ponytail:` comment naming the ceiling:
  new Core part types (e.g. reasoning) are silently dropped by the text-delta/tool-call
  filter; upgrade path is a Core-level stream→generate projection if a second Provider
  needs it.
- **D13 — SSE decoder: tests only, no refactor.** `decodeStream` already accepts any
  `Stream<Uint8Array>`; the internal `decodeEvent(state, data)` transition already
  exists. Add direct table tests feeding synthetic SSE bytes into `decodeStream`:
  malformed JSON, orphan text/argument deltas, argument reconciliation
  (`function_call_arguments.done` prefix logic), missing terminal event,
  `item_id`-vs-`output_index` keying. Do not restructure `sse.ts`.
- **D14 — SDK Effect facade: test only, no curation.** ADR-0022 mandates the complete
  unchanged re-export; do not introduce named exports or wrappers. Add one snapshot
  test in `packages/sdk/test` asserting the export-name set of `@mitome/sdk/effect`,
  so Core surface widening/renames fail an SDK test and become reviewed acts.

## Phase ordering

Tracks A–D are independent and parallelizable across sessions (different packages).
Within a track, phases are strictly sequential. If run by a single agent, suggested
order: B1 → A1 → D → C → B2 → A2 (quick wins early, dependent phases last).

## Track A — packages/core

### Phase A1 — ToolExecution pipeline (D4, D5)

- Create `packages/core/src/session/tool-execution.ts`; move the contents of
  `toolkit.ts` (`makeToolkit`, `ComposedToolkit.execute`, post-Tool transform, result
  revalidation) and `approval.ts` (`makeApprovals`, prepared-call state,
  `needsApproval` wrapping, Approval protocol) into it, restructured as
  prepare → gate → execute → check with the Approval protocol as an explicitly-typed
  internal interface. Delete `toolkit.ts` and `approval.ts` (and their tests' obsolete
  parts) — no shims.
- `session.ts` consumes the pipeline and adapts its Pending outcome to the existing
  `approval-required` TurnEvent in one place.
- Tests: new contract tests against the pipeline interface (no model fixture, no
  Fibers): duplicate decision → `ApprovalResolutionError`; cancellation mid-pending;
  veto path; input-validation failure path; discard-on-deny; reset between Turns.
  Session-level approval tests shrink to one approve path + one deny path proving the
  event adaptation. Existing behavior is the spec — port assertions, don't invent new
  semantics.

### Phase A2 — Session internal seams (D6; depends on A1)

- Extract `packages/core/src/session/model-resolver.ts` and `step-runner.ts` per D6.
  `session.ts` becomes composition + Turn orchestration.
- Tests: ModelResolver contract tests with a fake Provider (parse failure,
  unregistered Provider, provision failure, cache hit, Scope-bound lifetime);
  StepRunner tests with a scripted model (part→event translation, recursion on
  unexecuted tool-calls, decision accumulation into the next prompt); `hooks.ts`
  contract tests (ordering, interruption, partial-start cleanup, first-error
  semantics) without model streaming.
- Existing `session.test.ts` integration coverage stays as the thin outer slice.

## Track B — packages/cli + packages/create-mitome

### Phase B1 — CLI application seam (D1, D2, D3)

- Define `ChildHost` and `Prompter` services in `packages/cli/src`; today's
  `child-host.ts` bodies become the production `ChildHost` layer; Effect `Prompt`
  usage and the stdin-EOF handling in `support.ts` move behind the production
  `Prompter` layer (module-global `stdinEnded` state is absorbed into the layer).
- Command handlers (`run.ts`, `init.ts`, `auth.ts`) yield the services and return
  `ExitCode`; drop `process.exitCode` mutation and the `attempt`/`waitForChild`
  wrappers where the service interface subsumes them. `index.ts` provides
  `BunServices + CliOutput + production ChildHost/Prompter` and maps ExitCode.
- Tests: new in-process test file(s) driving handlers with fake layers for
  definition selection, `--use` resolution, runtime check failure, auth
  login/logout branching (credential descriptor shapes), init happy path and
  each prompt-abort path, exit codes. Rewrite `cli.test.ts` down to the D3 smoke set.

### Phase B2 — Scaffold plan + selection policy (D7, D8, D9; depends on B1 for CLI-side tests)

- Deepen `create-mitome/src/template.ts` into plans + `writeScaffold` per D7/D8;
  move tsconfig/README generation out of `create-mitome/src/index.ts` into the
  project plan. Add shared selection-policy functions (D9) and use them from both
  `create-mitome/src/index.ts` and `cli/src/commands/init.ts`.
- CLI `init.ts` replaces `initializationPath`'s file loop + `initialize`'s writes
  with `defaultAgentPlan` + `writeScaffold`; create-mitome's `scaffold` does the same
  with `projectPlan`.
- Tests: direct tests in create-mitome for both plans (file sets, contents,
  ensure-empty failure naming the existing file) and the selection policy
  (custom-model trim/empty rejection). CLI init behavior tests use the B1 fakes.

## Track C — packages/providers (openai-codex)

### Phase C1 — decoder tests (D13; no production code change)

- Add `packages/providers/test/openai-codex/sse.test.ts` table tests per D13, reusing
  the existing `sse()` helper from `test/support.ts` where convenient.

### Phase C2 — Codex transport seams (D10, D11, D12)

- Introduce `CredentialStore` service + fs adapter in
  `packages/providers/src/openai-codex/`; rewire `transport.streamText` and
  `model.ts`'s `codexLayer` per D10 (`Layer.provideMerge(FetchHttpClient.layer)`).
- Migrate policy tests to stub client + fake store per D11; prune the server suite to
  the kept round-trips. Add the D12 `ponytail:` comment on `generateText`.
- Constraint: OAuth/credential storage implementations stay in `src/shared` and
  `credential-store.ts` (ADR-0031) — the service wraps them, it does not move them.

## Track D — packages/sdk

### Phase D1 — export-contract test (D14)

- One test snapshotting `Object.keys(await import("@mitome/sdk/effect")).sort()`
  (plus type-only export names if the repo has an established pattern for that;
  otherwise runtime names suffice). Failure message should say "Core surface changed —
  widen deliberately and update this snapshot."

## Risks

- A1 is the highest-risk phase: `approval.ts`'s prepared-state/decision semantics are
  subtle (fail-closed needsApproval, veto-before-approval ordering, `ensuring`
  fallback resolution). Port behavior exactly; the existing `approval.test.ts`
  assertions are the spec and must all survive (relocated, not weakened).
- B1 rewrites the repo's most-churned test file. Do it as: add in-process tests
  first (green), then delete superseded spawn tests in the same PR — never a window
  with neither.
- C2 changes `codexLayer`'s layer composition; verify the CLI end-to-end smoke run
  still authenticates and streams (the kept server tests cover the seam, the CLI
  smoke test covers the wiring).
- Effect-beta API drift: consult effect-solutions before every service/layer
  definition; do not pattern-match from v3 memory.
