# Session/Turn and persistence contract evidence

Status: **investigation checkpoint, not a production API or completed contract**. The [library plan](../plans/effect-native-library.md) remains canonical; ADRs [0057](../adr/0057-use-effect-native-functions-and-optional-host-composition.md) and [0056](../adr/0056-separate-history-compaction-and-execution-recovery.md) own the selected lifecycle/recovery direction. [#170](https://github.com/chenxin-yan/mitome/issues/170) tracks persistence decisions. No production code or dependencies changed.

The later [integrated native execution proof](native-generation-boundary.md#integrated-sessionturn-proof) imports the rc.117 ownership kernel unchanged and verifies native generation/Tool handling, builder-service lifetimes and cleanup-before-save under its stated bounds. Persistence qualification remains separate.

## First experiment

Against installed Effect `4.0.0-rc.108`, an actual generic unary Turn combinator (not a declared signature) preserves application success/error types and unrelated service requirements while providing ambient Session and active-Turn context. Both direct and pipe invocation work without `any` or broad casts. The first experiment deliberately leaves the program's Scope requirement with its caller; that lifetime choice is **superseded by the user's subsequent Turn-owned Scope decision**, not a final signature.

One fake string-staging program performs two generations and returns an arbitrary typed result. Successful completion saves once before publishing local history. Typed application failure, definite pre-write save failure, interruption and defects are exercised; overlap/nested same-Session admission rejects; separately allocated Sessions do not share state. One infrastructure Layer is acquired once for two Sessions. A native dropping PubSub bounds progress without driving execution.

The parent inspected the implementation and independently reran:

| Command, in scratch directory                     | Exit        | Meaning                                                                                                                                |
| ------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `node_modules/.bin/tsc -p tsconfig.json`          | 0           | Implemented generic boundary and exact type assertions compile.                                                                        |
| `timeout 20s bun checks.ts`                       | 0           | 15 named checks, including checks demonstrating limitations rather than guarantees.                                                    |
| `timeout 10s bun limitations.ts`                  | 0           | Reproduces an in-flight save committing after allocation-Scope close; **not** a passing ownership guarantee.                           |
| `python3 generate-controls.py`                    | 0           | Generates negative type cases and a deliberate publication-before-save bug.                                                            |
| `node_modules/.bin/tsc -p tsconfig-negative.json` | 1, expected | Four TS2322 diagnostics: unrelated services, caller Scope, store error, and acquisition requirements cannot be erased.                 |
| `timeout 20s bun checks-broken.ts`                | 1, expected | Mutant fails the unchanged-history assertion after failed save, at line 48.                                                            |
| `sha256sum -c source-hashes.sha256`               | 0           | 41 recorded source/runtime/proof hashes matched at verification. Later intentional decision-doc edits may change documentation hashes. |

Scratch primary source: `/tmp/mitome-session-turn-proof-rc108-20260924`; parent rerun log: `parent-verification.log`. These temporary files are evidence, not a published package or permanent repository test suite. Original `proof.ts` SHA-256: `cd9c4a7da73186d8bb84c7f2db8f057a59172b20bc089c6f450d655a4898d7d6`. The subagent workflow `e20994d0-c445-4867-91fe-28919d8421dc` retains the proof, persistence report, and independent review artifacts outside the repository.

## Initial findings and remaining adoption gates

- Allocation Scope alone does not own the caller's execution fiber: the experiment can complete a suspended save after its allocation Scope has closed. Admission, execution draining/cancellation, and store lifetime must be coordinated.
- A pending interrupt can produce an interrupted caller Exit after successful save/commit. An ambiguous save error can also follow an external write. Failed invocation/acknowledgement is not evidence of rollback; stable authoritative outcomes and reconciliation are required.
- Masking cancellation around save/publication is not bounded shutdown: a stuck save may never finish. A timeout cannot establish rollback or safely free resources still in use.
- Caller-scoped child fibers can perform external effects after the function returns. Revoking staging prevents late conversation mutation, not arbitrary external effects. The second experiment addresses this for the supplied Turn Scope under its stated lifetime preconditions; explicitly escaping jobs are not automatically made safe.
- Native Effect SQL rc.108's failed-COMMIT connection leak and lost primary errors are now reproduced on real SQLite and independently rerun (below). A supported upstream resolution remains an integration gate. No local patch/workaround is authorized.

The independent review accepted the evidence report but blocked treating these artifacts as settled production contracts. Fake generations do not test native AI/Tools, approvals, HTTP/TUI, durable outcomes, real database transactions, coordinator exclusion, restart/power loss, trees, Compaction, Skills, or subagents.

## Second experiment: ownership

The separate `/tmp/mitome-session-turn-proof-rc108-20260924/v2` implementation supplies a real Turn Scope and forks admitted execution into a Session-owned execution Scope. Under sequential release ordering with protected single-owner closure (or a distinct enclosing infrastructure lifetime that awaits Session closure), its checks demonstrate cleanup before save and Session close draining admitted work before infrastructure release. Explicitly nested different-Session Turns remain independent; a child commit survives a later parent failure. The generic boundary now legitimately removes the provided Scope requirement while preserving exact application results/errors and unrelated services.

The parent inspected the implementation/tests and reran every documented gate; full output is `v2/parent-verification.log`:

- Strict `tsc -p tsconfig.json`: exit 0.
- `bun checks.ts`, `bun owned-checks.ts`, and both `bun boundary-controls.ts turn/session`: exit 0 (14 inherited checks, seven ownership checks, two controls).
- Generated negative type cases: exit 1 with three intended TS2322 diagnostics; two ownership mutants: exit 1 at the intended cleanup-before-save / drain-before-close assertions.
- `sha256sum -c source-hashes.sha256`: exit 0, 43 hashes matched. `v2/proof.ts` SHA-256: `51e2a0b03d2f47b15e9b311a246ad84ecd65cb3746b3834c4ff91ab2a89c5fa7`.
- `timeout 3s bun never-save.ts`: exit 124 after its explicit limitation message. A never-resolving masked save still prevents completed shutdown; this is not a rollback guarantee.
- `timeout 5s bun observer-regression.ts join`: exit 124, reproducing rc.108's skipped fiber-exit observer; `bun observer-regression.ts await`: exit 0.

The last issue is already upstream [#7338](https://github.com/Effect-TS/effect/issues/7338), with fix [#7344](https://github.com/Effect-TS/effect/pull/7344). Inspected rc.117 source snapshots the observer list before dispatch. The scratch proof uses native `Fiber.await` followed by yielding its Exit to avoid this rc.108 hang; this is not approval to carry a version-specific production workaround. Both observer variants now pass on the isolated rc.117 runtime (below); the full bounded ownership revalidation is recorded below. The proof also explicitly closes Scope and combines body/cleanup causes; no installed source is patched.

Independent v2 review accepted the bounded proof with two reporting qualifications, not production approval. Earlier acquisition in the same parallel Scope does not ensure infrastructure outlives Session drain; interrupted raw `Scope.close` and repeated close calls are not demonstrated completion barriers. Also, combined body/cleanup causes are retained in the admitted execution's result/non-cancelled caller; the proof does not establish their delivery to a caller cancelled during held cleanup. The rc.117 experiment below now tests that intersection; it does not add a cancelled-caller diagnostics guarantee. These checks do not cover native AI/Hosts/durable storage. Scope ownership is not a sandbox: explicit detached/outer-scoped work and unjoined `forkChild` are not automatically turned into Turn-scoped work. Needed work must be joined or use the supplied Scope. Raw Scope closure is not a promised concurrent/re-entrant shutdown API. Interrupted acknowledgement, unknown saved outcomes, shutdown deadlines and durable reconciliation remain unresolved.

## Ownership revalidation on rc.117

The parent inspected the real implementation and focused tests under `/tmp/mitome-session-turn-proof-rc117-20260924`, independently reran the full command set, and read its output. Native `Effect.scopedWith` replaces manual Turn-Scope/Cause handling, and ordinary `Fiber.join` replaces the old observer compensation. No custom supervision, package patch or production change was needed. Independent fresh-context review found no issues and accepted the bounded proof with the same lifetime qualifications.

Strict compilation and runtime checks pass: 14 inherited cases, seven ownership cases, four qualification cases (one deliberately demonstrates excluded parallel-Scope misuse), two boundary controls and both observer variants. Three negative type erasures and two ownership mutants fail at their intended assertions. The never-resolving save still times out with exit 124: shutdown remains unresolved, not successful. All 52 source hashes match; all 155 Effect compiler inputs resolve to isolated rc.117. Commands and complete results: `parent-verification.log` and `parent-compiler-files.log` in that directory. Implementation SHA-256: `333419fbc212a830d0fde966f65d3aabd7cb01df7c6833497de8db46972aed6e`.

The cancellation intersection is now explicit: the admitted execution retains exact body failure plus cleanup defect, but its cancelled caller receives only interruption. Cleanup finishes, save does not run, and the Session is reusable. A separate native nested-scope test demonstrates infrastructure remaining live through protected Session closure even if the owner is cancelled. This does not make raw repeated/concurrent close a completion barrier, nor acquisition order in a shared parallel Scope safe.

This resolves the bounded newer-runtime ownership proof, not native AI/Host integration, supported platform coverage, durable outcomes, cancellation acknowledgements or shutdown policy. Ownership execution used Bun 1.4.0 with isolated Effect rc.117; repository dependencies remain rc.108.

## Persistence investigation

The leading candidate is a local SQLite transaction domain holding committed history, staged execution, authoritative decisions, routing and outcomes. Extending independent JSON snapshots and observation JSONL would require a new transactional log/recovery protocol. SQLite still cannot restore arbitrary JavaScript/Effect continuations or guarantee exactly-once external side effects.

The current file replacement/append implementations have no file/directory synchronization or multi-record atomic commit. Installed runtime observations were Node `26.7.0` and Bun `1.4.0`; matching upstream Effect SQLite adapter source exists but the adapter packages are not installed. Runtime import/API checks are not driver-integration evidence. Node 24 minimum-patch/platform compatibility remains to verify; no runtime floor is changed by this investigation.

Under the selected machine-crash acknowledgement requirement, WAL with explicitly verified `synchronous=FULL` is a candidate; rollback DELETE with EXTRA is another. No journal mode or backend has been accepted. Keep transactions short, never across model calls or Approval waits. One database and one coordinator do not eliminate ambiguous external outcomes, duplicate delivery, or accidental competing coordinators. Power-loss claims remain conditional on supported VFS/filesystem/device synchronization; process-kill tests alone cannot prove them.

Primary sources: [SQLite WAL](https://www.sqlite.org/wal.html), [synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous), [transaction failures](https://www.sqlite.org/lang_transaction.html), [atomic commit assumptions](https://www.sqlite.org/atomiccommit.html), [Node 26.7 SQLite](https://nodejs.org/download/release/v26.7.0/docs/api/sqlite.html), [Bun SQLite](https://bun.com/docs/runtime/sqlite), and [Effect source at inspected rc.108 checkout](https://github.com/Effect-TS/effect/tree/bef7bf38ae4b73d5511043f707aed083de5da7cc/packages).

## SQLite transaction diagnostic

The parent inspected and independently ran `node /tmp/mitome-sql-transaction-proof-rc108-20260924/repro.mts` (exit 0; 16 records ending `PASS`, in `parent-output.jsonl`). Passing means the bad behavior was reproduced, not that transaction handling is correct. The unmodified copied rc.108 Node adapter matched upstream with `cmp`; proof SHA-256 is `d8bf7f44c79261279a7b349c4461fa47b381521734daf6790383742626333c9c`. Execution used installed Effect rc.108, Node 26.7.0 and actual SQLite 3.53.4, with WAL/FULL/foreign keys verified.

- A deferred foreign-key COMMIT failure returns a defect while the writer retains its uncommitted row and lock. A peer sees no row. The next otherwise-valid transaction fails before its body runs because the previous transaction remains open.
- Failed BEGIN under real writer contention returns an invalid-rollback defect, hiding the original busy error.
- Separately labelled synthetic rollback failures remove the primary body/BEGIN error from the returned Cause. Normal commit and body-failure rollback controls pass.

The failed-BEGIN behavior was subsequently corrected; do not treat the rc.108 result as an unresolved current-version finding. Inspected rc.111 and [rc.117 source](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.117/packages/effect/src/unstable/sql/SqlClient.ts) place BEGIN outside body cleanup and use different exit handling. Do not extrapolate rc.108's lost-primary-Cause result to those versions without execution. The failed-COMMIT branch still has no explicit rollback in rc.117 and [main at `330b7475`](https://github.com/Effect-TS/effect/blob/330b7475e2135bb9bc6aad1df5d513d32299ebc1/packages/effect/src/sql/SqlClient.ts); that is source evidence, not a newer-version runtime reproduction.

### Published rc.117 verification

With explicit owner authorization, matching official `effect` and `@effect/sql-sqlite-node` rc.117 tarballs were integrity-checked and extracted only under `/tmp/mitome-sql-transaction-proof-rc117-20260924`, without lifecycle scripts or dependency symlinks. No additional runtime dependencies were required. The parent independently compared all 2,546 Effect and 96 adapter files against the SHA-512-verified archives, inspected both test programs, reran them and read their complete output.

| Parent rerun                                  | Exit            | Result                                                                                                                                                                      |
| --------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node diagnostic.mjs`                         | 0               | 14 diagnostic records: normal controls pass; failed BEGIN remains typed; synthetic rollback failure preserves the primary Cause; failed COMMIT still leaks the transaction. |
| `node desired-commit-cleanup.mjs`             | 1, intended red | Fails the assertion that the next valid transaction can run after failed COMMIT.                                                                                            |
| `timeout 5s bun observer-regression.ts join`  | 0               | The exact rc.108 observer hang is fixed.                                                                                                                                    |
| `timeout 5s bun observer-regression.ts await` | 0               | Observer control passes.                                                                                                                                                    |

Logs are `parent-diagnostic.log`, `parent-desired.log`, `parent-observer-join.log`, and `parent-observer-await.log` in that scratch directory. SQL used published JS exports on Node 26.7.0 / SQLite 3.53.4; observer checks used Bun 1.4.0 with the same rc.117 Effect. Diagnostic SHA-256: `aa8fdc259e488066191aa23721ade987fba29f0ff5b49f406da3f225a3def7a5`; desired-test SHA-256: `6fe60aad950157fc446e3924ef35c8ea58ffdbd212d91261a7fc7c1c985c8665`.

**Remaining integration blocker:** deferred-constraint COMMIT failure leaves the writer's uncommitted row and lock alive; an independent peer sees no row, and two subsequent valid transaction bodies never run because BEGIN still encounters the old transaction. The corrected failed-BEGIN path no longer accidentally rolls it back. Upgrading to rc.117 alone therefore does not solve this blocker. Seek a focused upstream failed-COMMIT resolution, not a local cleanup/retry wrapper or duplicate report of the fixed bugs.

Published-package execution does not prove full type compatibility, Node 24/Bun SQLite support, ambiguous I/O commits, crash recovery or power-loss durability. The separate ownership revalidation above removes the obsolete rc.108 handling; it does not clear this independent SQL integration blocker.

## Cross-session context and runtime clarification

The other repository session supplied the earlier `/tmp/mitome-durability-handoff.md` and independently compared its approved decisions against the current glossary, ADRs, plan and #170/#174. No approved history/recovery/Compaction requirement, acceptance gate or deferral was missing or contradicted. That session has no writer claims; its handoff predates the function-first redesign and is historical, not a second specification.

The pinned pi checkout still matches `d981de1229ef899957bbe968bc8dcda02a21f477`. Its `getUserMessagesForForking()` enumerates all session entries, not just the active Branch; that implementation detail is not an additional Mitome navigation requirement. Ordinary coding Session behavior must remain distinct from pi's separate harness/recovery capabilities.

Runtime fact-finding clarifies that `packages/cli/scripts/mitome.mjs` uses Node only to locate and spawn a compiled binary. Its Node >=22.14 launcher floor is not the Agent or SQLite runtime floor. The compiled CLI and current TUI execute on Bun; direct core/SDK/HTTP packages declare Node >=24. Preserving both paths means verifying two runtime support targets, not necessarily selecting two storage formats. Cross-target binary packaging is not native platform validation. The owner subsequently selected Node 24 or newer plus Bun, including first-party durability on both, and all eight existing binary targets. The canonical plan owns that target matrix; exact eligible runtime patch versions and native platform validation remain unproved.

## Selected decisions and next proof

The owner selected:

1. Acknowledged saved work/Approval/cancellation must survive process and OS/power failure on supported storage honoring flushes; no broken-hardware/corruption guarantee.
2. Invocation-owned resources and scoped children belong to a Turn Scope, settle/clean up before commit, and do not implicitly escape to the caller. Shared infrastructure is acquired outside; programs explicitly join required child results/success. The owner subsequently clarified native Effect semantics: unjoined child Exit failures (including child cleanup defects) do not fail the Turn automatically, while the Turn's own scope cleanup defects do. Waiting for a child to stop is not joining its success.
3. Durable Hosts may accept custom programs lacking resumable continuations. Resume only supported compatible continuations after a crash; otherwise pause for reconciliation, never replay arbitrary code.
4. First-party durable storage initially requires supported local disk; remote clients may connect through HTTP, but network-mounted database files and remote database services are outside initial support. Backend remains undecided (ADR-0056).

Next decisions: durable identities/atomicity/recovery/retention and the remaining lifecycle protocol details. The owner selected durable-request cancellation acknowledgements (ADR-0056) and best-effort standalone CLI shutdown with application-owned escalation when embedded (ADR-0050). Those policies are not implemented or proved by this scratch boundary. Runtime/platform targets are selected, but exact supported versions and validation remain gates. The bounded rc.117 ownership proof is independently validated without obsolete compensation; its lifetime/cancellation qualifications remain. SQL integration separately requires a supported failed-COMMIT resolution. The authorized isolated rc.117 verification is complete; repository dependencies remain unchanged. No backend/schema selection, repository dependency change, fix contribution, local workaround, or production migration is authorized. Remaining shutdown, stable outcome, compatibility, identity, retention and feature contracts stay open under #170 and the library plan.
