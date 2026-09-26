# Native Effect generation and Tool authorization boundary

Status: **bounded native generation/Tool execution inside Session/Turn independently reviewed and parent-reproduced**. The integrated proof below covers process-local staging, service lifetimes and cleanup-before-save; it does not select a public API or establish durable storage. Independent review and parent reruns confirm the evidence below. Two original consumer-cleanup assertions fail, but the ownership reassessment distinguishes that behavior from a proven upstream lifecycle bug. This supports the [canonical plan](../plans/effect-native-library.md), not a new public API or production implementation.

## Version and evidence

Primary source is the already isolated `effect` **4.0.0-rc.117** package at `/tmp/mitome-sql-transaction-proof-rc117-20260924/node_modules/effect`. Paths below are relative to its `src/unstable/ai/`. Repository dependencies remain rc.108. The source scout's initial report was challenged by parent inspection; the conclusions incorporate its corrective addendum and the subsequent scratch proof. The source audit ran no tests; the later compiler/fake-model tests and parent reruns are distinguished below.

## Supported building blocks

- `LanguageModel.generateText` supports `disableToolCallResolution: true` for caller-controlled local Tool resolution (`LanguageModel.ts:254–300,1211–1229`). Reuse native Tool declarations and Prompt/Response schemas; do not copy the private dispatcher.
- `Toolkit.toLayer` and `toHandlers` accept ordinary handler maps. `HandlersFrom<Tools>` supplies decoded parameter types and a native handler context (`Toolkit.ts:92–105,114–128,173–181`).
- `Toolkit.WithHandler.handle` returns an **Effect producing a Stream**, not merely a lazy Stream (`Toolkit.ts:205–229`). Its outer Effect decodes parameters and starts the handler fiber before returning the result Stream (`328–417`). Consuming that Stream observes results/errors; delaying consumption does not delay execution.
- Tool failure modes distinguish typed errors from returned failure values. Preliminary output is not an authoritative final result (`Tool.ts:964–1022`; `Toolkit.ts:419–452`). Preserve those distinctions rather than treating every emitted value as success.
- Native `Chat` owns its own history updates, including streaming finalization (`Chat.ts:442–489`). It is not proof of Mitome's whole-program staging/commit boundary. Native Prompt/Response data can still be reused.

## Candidate authorization seam

Calling an application policy before `handle` does **not** establish authorization of the exact once-decoded arguments: decoding belongs to `handle`. Decoding separately can repeat effectful transformations. There is no public pause/hook between `handle`'s decode and handler invocation in the inspected API.

The supported candidate is ordinary **handler registration composition**: pass native `toLayer`/`toHandlers` a handler that receives the decoded value, checks fail-closed policy/consent, records intent, and only then invokes the original handler with that same value. This is not private Context interception, a patched Toolkit, or a replacement Tool schema.

Its costs and limits remain explicit:

- It requires participating handler registration. It does not transparently intercept arbitrary prebuilt native handler Layers.
- Native handler types constrain available errors and dependencies. Any gate error mapping, captured acquisition services and per-invocation requirements must be shown by the compiler, not hidden with casts.
- `Tool.HandlerServices` includes parameter decoding services, while `handle`'s signature places services on the returned Stream even though decoding occurs in the outer Effect (`Tool.ts:877–888`; `Toolkit.ts:205–229,367`). The subsequent probe confirms normal whole-composition provision works, but inner-only provision compiles and defects during outer decoding. This is not a sound requirement declaration for every consumption pattern.
- Cancellation, early Stream exit and failure-mode handling must not allow an unauthorized handler, abandon live child work before commit, or misclassify failure output as permission.

The bounded composition works in isolated scratch; no public helper or authoring contract is selected. The fixture explicitly declares gate failures in its Tool failure schema and gate services in Tool dependencies. It therefore does not prove arbitrary gate errors/services fit unchanged Tool declarations. The later integrated proof covers effectful handler-builder acquisition, structurally nested captured-service lifetimes and invocation overrides for its concrete fixture. It does not prove unrestricted middleware or escaped-handler safety.

## Tool variants are not interchangeable

`Tool.dynamic` can take raw JSON Schema without the Effect Schema parameter-validation guarantee; that path supplies unknown parameters (`Tool.ts:1295–1308,1423–1438`). Provider-executed Tools may already have acted upstream and cannot be retroactively authorized by a local handler gate. Disabled local resolution does not prove otherwise (`LanguageModel.ts:1217–1235`).

The initial focused proof covers application-executed Tools with Effect Schema parameters. That bound does **not** silently exclude other Tool variants from the product; supported validation/authorization policy for them remains an explicit design question.

## Native approval fallback: precise qualification

In both inspected rc.108 and rc.117, private `isApprovalNeeded` ends in `Effect.orElseSucceed(constFalse)` (`rc.117 LanguageModel.ts:2120–2143`). This confirms a **typed-failure fallback to no approval needed**, not that every synchronous throw or defect becomes false. `needsApproval` itself is typed as boolean or `Effect<boolean>` without declared typed error/environment channels (`Tool.ts:125–161`). The audit did not reproduce an unauthorized execution or prove an exploit.

Native approval artifacts are not Mitome's authenticated decision service. The controlled design must establish its own fail-closed authority. If a chosen path needs different native automatic-approval behavior, seek an upstream-supported change rather than patching internals. No approval-fallback fix, report or local workaround is authorized by this note.

## Parent-reproduced proof

Scratch: `/tmp/mitome-tool-boundary-proof-rc117-20260925`. Runtime: **Bun 1.4.0, Linux x64**; compiler: **TypeScript 7.0.2**. Runtime and all **214 Effect compiler inputs** resolve to isolated rc.117, not repository rc.108. No packages were installed or changed.

The parent read the fixture, type assertions, controls, full failure logs and consequential upstream sources, then independently verified **14 fixture/setup files and 2,708 upstream/compiler/contract files** against the retained hashes before rerunning `run.sh`.

Verified behavior:

- Disabled resolution does not dispatch local handlers even with handlers installed. The fake model's second generation sees a valid native Prompt with two matched calls and final results; preliminary results are excluded.
- One schema decode supplies the same decoded object to policy, intent and original handler. Invalid input, denial, missing-consent stand-in, typed policy failure, policy defect and intent failure prevent original-handler entry. Held intent must settle before execution.
- Explicit calls run serially. Native result validation, declared typed errors and defects remain distinct. Return-mode gate failure is a failure value, not authorization success.
- Exact compiler assertions preserve unrelated application A/E/R and declared Tool/decoder requirements in normal flattened composition. Eight negative assignments reject erasure or undeclared Tool A/E/R. `skipLibCheck` means this is consumer-contract evidence, not a check of all upstream declarations.
- Full draining settles the bounded handler's finalizer. Interrupting the owning child fiber settles a held policy gate. These do not establish all consumer-exit paths or a Turn/save boundary.

| Parent-rerun command                              |       Exit | Meaning                                                          |
| ------------------------------------------------- | ---------: | ---------------------------------------------------------------- |
| `bun resolution.ts`                               |          0 | rc.117 runtime/compiler provenance                               |
| `bun "$TSC" -p tsconfig.json` and `--listFiles`   |     0 each | Positive exact types and compiler inputs                         |
| `bun checks.ts`                                   |          0 | 21 checks, including explicit unsafe-behavior counterexamples    |
| `bun "$TSC" -p tsconfig-negative.json`            | 1 expected | Eight intended type rejections                                   |
| `env MUTATE_ORDER=1 bun checks.ts`                | 1 expected | Ordering assertion detects execution before policy               |
| `env EXPECT_CLEANUP=early-stop bun checks.ts`     |          1 | **Desired cleanup safety fails**                                 |
| `env EXPECT_CLEANUP=consumer-error bun checks.ts` |          1 | **Desired cleanup safety fails**                                 |
| `timeout 60s bash run.sh`                         |          0 | Evidence collection matches expected exits; not universal safety |

`$TSC` is the repository's existing `node_modules/typescript/bin/tsc`. Full parent output is `parent-rerun.log`; individual logs include `runtime.log`, `negative.log`, `mutation.log` and both `desired-*.log` files. `parent-upstream.sha256` substitutes frozen copies of the two consumed contract documents so subsequent plan edits do not invalidate those historical source hashes. `fixtures.sha256` retains the tested fixture hashes; `fixture.ts` is `9a9b8c12d182504dfd1da572817434d22023d38158eda3f5c81235dd55b33b44`.

## Confirmed native limitations and next gate

1. **Consumer settlement is not handler settlement.** With the owner fiber alive, both early success (`take(1)`) and consumer error return before handler cleanup; releasing the held handler then produces a write. Native `handle` starts a child fiber and attaches interruption through `Stream.onEnd`, which handles successful upstream completion, not every consumer exit (`Toolkit.ts:408–452`; `../Channel.ts:10113–10138`). Both desired safety assertions remain red. These are post-consumer-settlement writes, **not a reproduced post-Turn-commit write**: the fixture has no Turn/save boundary.
2. **Decoder requirements are on the wrong phase.** Outer `handle` declares no environment, but decodes before returning the Stream. Supplying Decoder only to the inner Stream compiles and defects with `Service not found: proof/Decoder`. Supplying it around the complete composition works (`Toolkit.ts:205–229,367`).
3. **Return-mode inner errors are understated.** `Tool.HandlerError` declares `never` for return mode, yet Stream result encoding can fail with typed `ToolResultEncodingError` (`Tool.ts:1016–1022`; `Toolkit.ts:446–449`). The flattened composition already includes outer `AiError`; the counterexample concerns the extracted inner Stream declaration, not missing aggregate E there.

The two error/service declaration mismatches belong upstream. The lifecycle observation alone does not establish an upstream contract violation or require a local workaround: the handler belongs to the fiber invoking `handle`, not necessarily its later result consumer. Preserve the original failing controls, but do not treat stronger consumer-ownership expectations as an upstream promise. The native ownership reassessment below replaces the earlier blanket recommendation to block adoption on upstream lifecycle changes. No private dispatcher or patch was added.

The later integrated proof addresses the tested builder-service lifetimes and cleanup-before-save gap. Remaining gates include generalized public authoring contracts, authenticated approvals, durable intent/outcome writes, result sanitization and the Tool variants above; consumer exit is still not a universal ownership boundary. Fake-model/in-memory evidence does not establish SQL durability, power-loss recovery, real provider serialization or additional runtime/platform support.

## Ownership reassessment: upstream defects versus integration duties

A fresh independent source challenge classified the two type mismatches as confirmed upstream bugs, but the lifecycle case as an ownership ambiguity. The parent then removed all Mitome composition, policy, intent and model code from the probes in `/tmp/mitome-tool-triage-rc117-20260925/native-only.ts`.

Both type counterexamples still reproduce with native Tool/Toolkit alone. For lifecycle, the same held handler and asynchronous finalizer were tested against three ownership arrangements, for both early success and consumer error:

| Arrangement                                                              | Cleanup complete at boundary? | Later handler write? |
| ------------------------------------------------------------------------ | ----------------------------- | -------------------- |
| Consumer finishes; invoking fiber stays alive                            | No                            | Yes                  |
| Same operation wrapped only in `Effect.scoped`                           | No                            | Yes                  |
| Operation runs in its own native child fiber; caller awaits `Fiber.join` | Yes                           | No                   |

`Effect.scoped` closes its resources; it does not by itself end the current fiber that owns `forkChild` children. The joined-owner result demonstrates ordinary native structured concurrency, not a patched Toolkit or a promise that every Stream consumer owns execution. Native `LanguageModel` likewise manages handler jobs separately from passive consumption (`LanguageModel.ts:1561–1632,1689–1701`; upstream [PR #7486](https://github.com/Effect-TS/effect/pull/7486) describes model-owned cancellation).

Parent commands: strict consumer compilation and `--listFiles` each exit **0**; `timeout 10s bun native-only.ts` exits **0** on two runs, asserting both type counterexamples and all six ownership controls. Logs and `triage.sha256` are retained in that scratch. This is not yet the combined Session/Turn/save proof and does not establish arbitrary uninterruptible or detached-user-work guarantees.

Current upstream source was also inspected at [`e36c35c656bb5cc6dd1170d863ea8abb75c24279`](https://github.com/Effect-TS/effect/tree/e36c35c656bb5cc6dd1170d863ea8abb75c24279). AI source has moved to `packages/effect/src/ai/`; the same outer-R, return-mode inner-E and `onEnd` code remains in [Toolkit](https://github.com/Effect-TS/effect/blob/e36c35c656bb5cc6dd1170d863ea8abb75c24279/packages/effect/src/ai/Toolkit.ts#L213-L238) and [Tool](https://github.com/Effect-TS/effect/blob/e36c35c656bb5cc6dd1170d863ea8abb75c24279/packages/effect/src/ai/Tool.ts#L1058-L1064). This is a source check, not execution of a newer package. Targeted issue/PR searches found related work, but no exact existing report for these two type mismatches; search absence is not proof none exists. Open documentation [PR #8156](https://github.com/Effect-TS/effect/pull/8156) explicitly distinguishes result-encoding failures from captured handler failures: the defect is the missing inner error type, not necessarily the choice to fail encoding. With explicit owner approval, the two focused type reports were subsequently opened and their bodies read back exactly: [outer Decoder requirements #8526](https://github.com/Effect-TS/effect/issues/8526) and [return-mode inner error type #8527](https://github.com/Effect-TS/effect/issues/8527). Each includes a separately compiled/executed native-only reproduction. No lifecycle issue was filed.

**Recommendation:** track the two upstream type reports. On Mitome's side, provide services around the complete handle-and-consume operation and give controlled execution a native owner whose settlement is awaited before publication. In the tested flattened operation, aggregate R includes Decoder and aggregate E already includes AiError. This supported composition does not require changing upstream declarations locally. The integrated proof below now checks the bounded Turn path; selecting its public API remains separate. Do not require an upstream lifecycle fix merely because a consumer finished while its owner remained alive.

## Integrated Session/Turn proof

Scratch: `/tmp/mitome-integrated-execution-proof-rc117-20260925`. The functioning fixture imports the earlier Session/Turn kernel **unchanged** and combines it with native generation, serial Toolkit handling and real Prompt Messages. A fresh independent reviewer found no issues within the stated bounds; the parent inspected the implementation, types, controls, consequential native source and full failure logs, verified the retained hashes, then reran the complete suite.

### Verified integration

- An ordinary Effect program stages user input, executes two native fake-model generations and two serial Tool calls, then returns its exact application result. Policy and the in-memory intent hook see the same once-decoded argument as the original handler. Actual committed conversation remains unchanged until one save after successful completion and required cleanup.
- Conversation chunks round-trip through native `Prompt.Prompt` Schema encoding/decoding and JSON for the fixture's text/call/result data. Preliminary results are not final conversation; finish/usage metadata is not an execution ledger. This is not a general media, provider-metadata or durable result codec.
- Controlled handling owns the entire outer Effect and inner Stream in a native child fiber. A protected join has an interrupt/drain finalizer: cancellation of the wait is not mistaken for child settlement. Held asynchronous cleanup blocks save, caller completion and Session reuse even after the result consumer has stopped. Releasing obsolete handler gates cannot revive settled work.
- Handler `ensuring` cleanup finishes with its operation; resources acquired in the supplied Turn Scope finish at Turn closure, before save. Structurally enclosing handler-builder and infrastructure lifetimes outlive Session drain. Captured registration context does not override the invocation service or actual Turn Scope. Escaping handlers beyond the captured infrastructure lifetime deliberately fails a negative control.
- Unrecovered body/model/Tool/policy/intent errors and defects, plus Tool-own full-drain cleanup and Turn-own cleanup defects, prevent the affected save. Completed external effects remain completed. Native unjoined-child failures are not promoted into parent commit authority; waiting for settlement does not imply collecting every descendant Exit.
- Early, failing and slow passive observers neither drive nor cancel execution. Slow observation drops progress through the existing bounded PubSub. Session shutdown drains active native work before releasing enclosing infrastructure.

The fixture additionally requires a finish part before handling calls and accepts only native complete finish reasons. Rejecting a missing finish part is a **fixture choice**, stricter than inspected native automatic-resolution behavior, not a newly approved provider policy. The error-mode fixture aborts on denial; a return-mode control deliberately continues after denial without running the original handler. Applications can recover failures; neither a recovered incomplete Tool result nor a failed result value grants execution authority.

### Types and evidence

The unchanged generic `withTurn<A, E, R>` preserves A, unions its boundary errors into E and supplies only Session, ActiveTurn and Scope requirements. Concrete exact assertions cover the native operation, program, Turn, application, builder, `toHandlers` and `toLayer`. Invocation requires Decoder, Policy, Invocation and Scope; acquisition separately requires Infrastructure, BuildInput and Scope, with Layer managing its own acquisition Scope. Nine negative assignments reject erasing application result/error/services, decoder/invocation requirements, builder infrastructure/error/Scope or registering undeclared Tool requirements.

Parent verification on **Bun 1.4.0/Linux x64, TypeScript 7.0.2, isolated Effect rc.117**:

| Check                                             | Exit / result                                             |
| ------------------------------------------------- | --------------------------------------------------------- |
| `sha256sum -c fixtures.sha256`                    | 0; all 15 fixture/setup hashes match                      |
| `sha256sum -c sources.sha256`                     | 0; all 424 focused source/compiler/input hashes match     |
| `sha256sum -c evidence.sha256`                    | 0; all 39 retained log hashes match                       |
| Positive compilation and `--listFiles`            | 0 each; all 214 Effect inputs resolve to isolated rc.117  |
| `bun checks.ts`                                   | 0; 26 integrated checks                                   |
| Negative compilation                              | 1 expected; nine intended TS2322 diagnostics              |
| Ownership mutant                                  | 1 expected; actual save rejects a still-active Tool       |
| Premature-history-publication mutant              | 1 expected; history changed after definite save failure   |
| Prior immutable ownership/Tool/native-only suites | 0 each; documented counterexamples remain counterexamples |
| `timeout 100s bash run.sh`                        | 0; all expected exits, no unexpected failure or timeout   |

The runner preserves earlier logs. Parent transcript: `parent-verification.log`; detailed parent output: `logs/run-qzHTHbwg/`. Fixture SHA-256: `2f98cf2d396b0ffc38ca698923d2d247dc126ac6fc3b30e711f2f6f38bdc113b`; unchanged imported ownership kernel: `333419fbc212a830d0fde966f65d3aabd7cb01df7c6833497de8db46972aed6e`. Frozen input documents prevent later planning edits from invalidating those evidence hashes. Consumer compilation uses `skipLibCheck`, not a validation of all upstream declarations.

**Accepted conclusion:** the tested native composition can preserve typed ordinary programs, stage real conversation and finish required cleanup before process-local commit without an Effect patch or a second engine. Public DX still needs participating registration and truthful error/service channels; this fixture explicitly declares gate requirements/errors but does not establish that authors must repeat them. The smaller authoring probe below checks internal provision without declaration changes. Arbitrary prebuilt Layers are not transparently intercepted. No public helper is selected.

Storage is an in-memory stand-in. No SQL, authenticated durable Approval, cancellation receipt, crash recovery, real provider, HTTP/TUI, broader platform or full replacement guarantee follows. Uninterruptible cleanup/save may still block indefinitely; detached work, escaped handlers, concurrent raw Scope closure and cancelled-caller delivery of retained execution causes retain their prior qualifications. Dynamic-schema and provider-executed Tool policy remains unresolved, not removed from scope.

## Unchanged-declaration authoring probe

Scratch: `/tmp/mitome-tool-authoring-proof-rc117-20260925`. A source-review challenge identified a smaller alternative to adding gate schemas/dependencies to every Tool: native handler contracts already permit `AiError`, and ordinary internal provision can supply library-owned gate services. The parent tested this candidate using unchanged native Tool declarations and a generic handler wrapper, with concrete single-Tool registration in each failure mode. An independent reviewer found no issues within these bounds; the parent subsequently reran the checks and verified all retained hashes. The reviewer inspected source/logs but did not execute checks or recompute hashes.

The wrapper maps only library-owned typed gate failures to native `AiError.UnknownError`, then invokes the original handler. Per-operation authority is explicitly supplied, not inferred from an ambient Layer. Verified controls cover once-only decoding and identical arguments through authorization/intent/handler; missing, inactive, mismatched or denied authority; failed intent and policy defects; unchanged application error/defect behavior in error mode; and denial/application failure values in return mode. An internally provided gated registration prevents entry into the tested ambient same-name/same-ID replacement handler. The author builder runs once and its normal lifetime encloses the operations.

On the same Bun/Linux, TypeScript and isolated rc.117 setup as the integrated proof:

- Positive strict consumer compilation: **exit 0**, eight exact assertions covering Tool requirements/failures, builder E/R, error-mode operation A/E/R and return-mode R. All **214 Effect compiler inputs** resolve to isolated rc.117; `skipLibCheck` remains enabled.
- Runtime: **exit 0**, six check groups in `parent-runtime.log`.
- Negative compilation: **exit 1**, six intended TS2322 rejections of erased invocation requirements/errors or builder requirements/Scope.
- Fail-open authorization mutant: **exit 1** at `denied or unowned calls must never enter handler`, observing two handler entries instead of one.
- `sha256sum -c evidence.sha256`: **exit 0**, all **231 hashes** verified in `parent-hashes.log`. Fixture SHA-256: `30cc187e98e4c3a632426ae41d9680a0fb70aa3ec8d82a3b1661b6ed08854a53`.

**Bounded conclusion:** repeating library gate dependencies/errors in each author's Tool declaration is not necessary for this composition. Prefer proving the unchanged-declaration path before introducing schema transformation. Generic native error text is not a dedicated typed denial case. After this review and parent verification, the owner selected native failure reporting without a promised dedicated machine-readable denial case; the [canonical authoring contract](../plans/effect-native-library.md#tool-registration-keep-library-plumbing-out-of-author-declarations) records that choice.

This is not a generic Toolkit registrar, collision validator, arbitrary prebuilt-Layer interceptor or public API. It does not separately assert Layer types or return-operation A/E, exercise builder acquisition failure, or test return-mode defects. Normal builder finalization is not held-cleanup, interruption-race or authority-expiry evidence. The native owner recipe is reused, not re-proved. Session/durable intent integration, provider/dynamic policy and discovery remain separate; no existing integrated-proof limitation or full-replacement requirement is waived.

## Generic registration and optional composition probes

Two further isolated probes generalize the authoring mechanism and check declarative composition separately. An independent reviewer inspected their source and retained logs with **no issues found**, accepting only bounded design evidence. The parent inspected the implementations, exact types, native source and full expected-failure logs, verified the historical manifests **before** rerunning, and ran both complete runners successfully. The reviewer did not execute commands or verify hashes.

### Participating registration

Scratch: `/tmp/mitome-generic-registration-rc117-20260925`. The generic candidate accepts a native Toolkit and an ordinary handler map or Effect builder. It acquires the builder once, snapshots its own enumerable bindings, and retains native definitions plus an always-gated operation—not exposed prepared handlers. Two heterogeneous Tools exercise different parameters, result codecs, errors, dependencies and failure modes without changing their declarations.

Acquisition captures context before evaluating the builder, matching native `toolkit.toHandlers`. Fresh operation-local handlers retain that captured context, while native invocation context takes precedence. Decoder/encoder services remain explicit whole-operation requirements; captured services are not silently removed from R. Authority is passed afresh to the controlled operation, not obtained from the captured handler context. Missing, mismatched, inactive or denied authority and failed intent prevent handler entry. Expiry during suspended authorization or intent is also checked, but these boolean checks do not establish durable atomic fencing or prevent changes after handler entry.

Visible names/IDs and exact handler keys are checked before the candidate can merge or register them. Tests reject missing bindings and prevent ambient, captured or separately prebuilt same-ID handlers from replacing the selected gate. Bindings are snapshotted against later author-map replacement. A deliberate counterexample retains the limit: an author's earlier `Toolkit.make` can already have discarded duplicate names, and registration cannot recover those inputs. No global registry or interception of arbitrary prebuilt Layers follows.

The operation's aggregate return type is explicitly annotated using native `HandlerResult`, `HandlerError` and `HandlerServices`; removing that annotation fails an exact application-error assertion. This is not a claim of unrestricted inference. Three localized record/key assertions support construction, enumeration and completion after exact-key validation; no handler, Effect, error or service is cast away. Relevant native source is rc.117 `Toolkit.ts:367–491` (decode, invocation merge, normalization and capture), `:508–518,636–650` (overwriting constructors/merge), and `Tool.ts:877–888,1016–1022` (service/error types).

The fixture selects ordinary host-executed Effect-Schema Tools only. Native dynamic/provider subtypes survive when merely carried, but their local selection is rejected in this probe rather than assigned invented semantics. Their product support remains unresolved, not excluded. Acquired bundles still require structurally nested lifetimes; this does not harden trusted Tool objects against arbitrary mutation or replace the integrated ownership proof.

### Optional composition

Scratch: `/tmp/mitome-composition-contract-rc117-20260925`. A plain optional record retains the **same ordinary Agent function**, one Provider descriptor tuple, native infrastructure and selection defaults. Direct invocation preserves a Map, bigint and function result without a codec or composition dependency. Discovery, structural validation, selection and declaration of the acquisition Effect invoke no provisioning factory, Layer acquisition, program, allocation or Host-start sentinel.

Only omission selects the default; malformed explicit selection rejects. Qualified IDs split at the first slash, and unlisted native IDs remain valid catalog hints rather than an entitlement list. Actual acquisition lazily calls only the selected provisioner. A genuinely fallible Provider Layer preserves construction E and unmet R instead of being coerced through native `Model.make`, whose construction E is `never`. Concrete application wiring retains infrastructure and program errors and closes its requirements with ordinary provision. Runtime-selected branches retain the union of possible E/R; no universal provider-builder inference is claimed.

One shared infrastructure acquisition encloses four fresh scoped allocation **stand-ins**. Selected-Provider and native Model overrides apply lexically to individual invocations, including ProviderName/ModelName, without mutating the default. Acquisition failures unwind already-acquired infrastructure and prevent program/allocation entry. These are not real Session/Turn or Host lifecycle tests.

The loader checks one explicit default-export shape and returns unknown-valued fields. Importing the selected module executes trusted JavaScript before validation. A structurally valid function returning a number deliberately passes: shape validation cannot establish an Effect return, erased A/E/R or closed provision. Env-only credentials, startup sentinels, format fields and synchronous validation exceptions are fixture choices, not selected product restrictions or loading/error protocols. Native sources: `Model.ts:130–165`, `Layer.ts:800–809`, and `LanguageModel.ts:790–810`.

### Parent verification and limits

Both runners used Bun **1.4.0/Linux x64** and isolated Effect **4.0.0-rc.117**, with **214 Effect compiler inputs each** resolving exclusively to that package. The repository compiler wrapper reports **`7.0.2+effect-tsgo.0.36.5`** and invokes a native executable; earlier records shortened this to TypeScript 7.0.2. The existing `bun node_modules/typescript/bin/tsc` path was used unchanged. Consumer compilation uses `skipLibCheck`; no compiler/dependency installation or patch occurred.

| Check                                   | Registration                                                 | Composition                                       |
| --------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| Complete `timeout 150s ./run.sh`        | 0                                                            | 0                                                 |
| Positive compilation / runtime          | 0 / 0; 21 exact assertions, seven runtime groups             | 0 / 0; 20 exact assertions, five runtime groups   |
| Negative compilation                    | 1 expected; 13 intended diagnostics                          | 1 expected; eight intended diagnostics            |
| Behavioral mutant                       | 1; denied handler entered, 3 calls instead of 2              | 1; discovery eagerly invoked a provision factory  |
| Inference counterexample                | 1; omitted annotation loses exact application E              | Not applicable                                    |
| Historical hashes verified before rerun | Nine fixture/setup, 388 source/input, four inference-variant | 15 fixture/setup, 883 source/input, nine log/exit |

Parent evidence: `/tmp/mitome-authoring-contract-parent-w2SScMwH/`. Detailed reruns: registration `logs/run-SOSkIUGp/`, composition `logs/run-8ELjoQca/`. Historical writer runs remain `run-Hha02JbD` and `run-uZnK72dn`. Registration implementation SHA-256: `c59d4b993b444ccb99e4089e61c2d034b1a3a541736eb7067a877bb464fefe6c`; composition implementation: `a1a97a41265b066ffe85d493bc6816491571595a87663e51eedeea5cb9a3c379`. Frozen document inputs keep later plan edits from invalidating historical manifests.

**Bounded conclusion:** heterogeneous participating registration and a small optional composition can preserve native authoring without a second framework. These probes do not integrate the new candidates into the actual Session/Turn kernel, requalify cancellation/drain, authenticate authority, prove durable intent/outcomes, select dynamic/provider Tool policy, or implement real Hosts/loading/serialization. No public names, complete loadable application protocol, implementation authorization or reduced #174 scope follows.

## Typed loading through the real Session/Turn boundary

Three subsequent fixtures connect the previously separate mechanisms. Independent review found no issues within each stated scope. The parent inspected the implementations and consequential evidence, verified historical manifests, and reran all three complete runners successfully. Reviews were source/log inspections, not independent command execution or hash verification.

### Typed producer, trusted dynamic boundary

`/tmp/mitome-loadable-application-rc117-20260925` retains the ordinary program in a plain composition and adds one application-closed execution entry. Its optional identity constructor preserves the concrete record type; using a record constraint does not replace the Agent with another abstraction. Exact producer checks preserve direct A/E/R and reject application, infrastructure or Provider requirements left unsupplied. The entry allows only the known host-supplied Scope requirement; native provision actually closes the application requirements. Defaults and Hosts are not made mandatory.

The loader imports one explicit default export and validates its supported shape without invoking callbacks. One isolated assertion accepts the **trusted producer's promised execution signature**. Dynamic A/E become unknown; they are not automatically safe result/error payloads. Checking `Effect.isEffect` at invocation detects a non-Effect return but cannot establish R or callback behavior. Imported counterexamples preserve the distinction: a function returning `123` passes shape checks then produces the fixture's protocol failure; a native Effect requiring an unsupplied service passes shape checks then defects with `Service not found: composition/AppData`. Neither the marker nor the assertion grants security authority, and arbitrary module initialization remains executable JavaScript.

This is an invocable trusted-module contract, not runtime recovery of erased types. Input/error/version fields remain fixture choices; future codecs must retain and genuinely supply their own requirements. Real long-lived Hosts must acquire shared infrastructure for their application lifetime, not reinterpret this single-invocation entry as a per-request application restart.

### Actual authoring integration

`/tmp/mitome-authoring-integration-rc117-20260925` imports the accepted Session/Turn kernel and generic registrar unchanged. Two heterogeneous native Tools, an ordinary builder and Agent function now execute through real `makeSession`/`withTurn`, not allocation stand-ins. Native Prompt staging, two fake-model generations, serial Tool execution and one post-cleanup save preserve application A/E/R without adding gate schemas/dependencies to Tool declarations. Invocation context and actual Turn Scope override registration context; the same Session/registration denies one invocation and subsequently allows another using fresh authority.

Checks cover held save and definite save failure; native error/return modes and deliberate recovery; body/handler/model/policy/cleanup failures; held Tool cleanup during success, encoding failure, cancellation and interrupted drain; busy/released Session behavior; and shutdown before infrastructure release. The optional composition retains the same function and shares one infrastructure/builder acquisition across three explicitly scoped Sessions with a model override and unchanged default. Missing-finish rejection remains fixture-only strictness, and Prompt encoding covers only its text/call/result data.

The generic operation still needs explicit native result/error/service annotations. Removing them produces six exact-error assertion failures. Behavioral mutants expose save during held cleanup, premature operation settlement with plain fork/join, and history publication before save. No original kernel or registrar was patched by these controls.

### Loaded real execution and the compatibility correction

The initial review correctly noted that two separate successful suites did not prove their connection. The parent added `/tmp/mitome-loaded-real-session-rc117-20260925`: the original loader first imports its real entry; that entry selects the native model, allocates the actual kernel Session and calls the original Agent through `withTurn`. Tests inspect actual Tool work, saved native conversation and resource state—not merely a returned value. Loaded denial publishes nothing. Loaded interruption during held cleanup keeps the caller pending, Session busy and infrastructure live; release allows settlement and Session closure without save. An execution-skipping mutant returns the same-looking result but fails at the missing actual save.

Connecting the sources under `exactOptionalPropertyTypes` exposed an **own-candidate typing mismatch**, not an upstream bug: the generic guard constrained `toolCallId?: string`, while native `Toolkit.HandlerContext` allows `toolCallId?: string | undefined` (`Toolkit.ts:118`). A new local registrar copy adds only `| undefined`. Its integration-fixture copy redirects only that import; the kernel is unchanged, and composition/regression checks/types are byte-identical copies. The runner verifies these exact relationships. The original constraint remains a two-diagnostic failing control; the corrected source passes without changing runtime behavior, adding casts or modifying historical evidence.

The connecting fixture proves one invocation-owned application lifetime. It does not establish long-lived serving ownership, concurrent request admission or application-wide reuse. Module-level state is test instrumentation; input contains bigint, and selection exceptions become defects. Those are not selected wire/error protocols.

### Verification record

All three use the existing **7.0.2+effect-tsgo.0.36.5** compiler wrapper, Bun **1.4.0/Linux x64**, isolated Effect **4.0.0-rc.117**, and **214 Effect compiler inputs each** resolving exclusively there. Consumer checking is strict with `skipLibCheck`; loading and the connecting fixture additionally enable exact optional properties. The earlier registrar's strict compilation did not establish compatibility with that additional option.

| Check                               | Typed loading                         | Actual authoring integration                                             | Loaded connection                                         |
| ----------------------------------- | ------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------- |
| Complete `timeout 150s bash run.sh` | 0                                     | 0                                                                        | 0                                                         |
| Exact type assertions               | 25                                    | 29                                                                       | Seven new, plus the 29 integration assertions             |
| Runtime                             | Seven groups                          | 24 checks                                                                | Three connecting groups plus 24 regression checks         |
| Intended negative diagnostics       | 12                                    | 12                                                                       | Three                                                     |
| Behavioral mutants                  | Two, each exit 1                      | Three, each exit 1                                                       | Skip-Turn, exit 1 with save count `0 !== 1`               |
| Other compiler controls             | —                                     | Six annotation-removal diagnostics                                       | Two original-constraint compatibility diagnostics         |
| Historical hashes verified          | 22 fixture/setup, 886 inputs, 16 logs | 11 fixture/setup, 2,725 inputs, two immutable imports, 46 evidence files | 12 fixture/setup, 2,771 inputs/imports, 22 evidence files |

Parent loading/integration evidence: `/tmp/mitome-loading-integration-parent-8RRf5rnN/`; detailed runs `logs/run-4P1W3RyF/` and `logs/run-n0rmQVzI/` under their respective scratches. Parent post-review connecting verification: `/tmp/mitome-loaded-session-parent-3R0WlkAK/`, detailed run `logs/run-l8sQ86Vp/`. Earlier writer/reviewed runs remain `run-6ENAFkNn`, `run-OUzpUijt` and `run-rYPeNjEP`. Connecting entry SHA-256: `0b85805e3a132cfac04e113aff41f383b18949013e512bd2f650b629b5ffedf8`; corrected registrar: `5085f9fc1d7c569b93776436129d9b1f6f36faa92e7deae555ac7d0ac640b73f`. Setup failures are retained separately; final negative checks verify the intended substantive diagnostics, not missing inputs or incorrect expected diagnostic codes.

**Bounded conclusion:** a trusted, statically closed producer entry can load and invoke the real Session/Turn/native Tool path without a second engine or erasing direct author types. The producer trust assumption, single-invocation scope, explicit generic annotations and prior ownership qualifications remain. No automatic serialization, authenticated authority, durable outcomes/recovery, real serving-Host protocol, dynamic/provider Tool policy, broader-platform support, public exports or full #174 acceptance follows. The SQL integration blocker remains independent.

## Remaining Step and Tool-variant contracts: source checkpoint

This follow-up is source inspection, not another executable proof. Two read-only scouts inspected the same isolated rc.117 package; the parent checked the consequential paths and qualified their recommendations. No dependency/source patch or runtime test ran. The repository remains on rc.108.

- **Keep complete native output.** `LanguageModel.GenerateTextResponse` has a public constructor, `content` and derived text/Tool/finish/usage getters (`LanguageModel.ts:376–463`). Returning the original response alongside this controlled operation's local Tool-result parts is a small candidate seam; it preserves provider metadata and distinguishes generated results from separately executed results. `Prompt.fromResponseParts` remains the native conversation projection, not a way to retain every metadata/error part. Exact generic signatures still require checking before becoming public contracts.
- **Completion needs an explicit policy.** The native getter reports `unknown` when finish metadata is absent. Native automatic resolution rejects explicitly incomplete finish reasons but its completeness helper does not reject absence (`LanguageModel.ts:2236–2255`). A provider Effect failure is different from a successful response carrying a finish/error signal. Missing finish alone therefore must not be described as a native failure requirement; acceptance of partial output and default-loop continuation remain product choices.
- **Disabling generated-call resolution is not a universal no-execution guarantee.** `generateContent` collects pending native approval artifacts, invokes `executeApprovedToolCalls`, and only later reaches the `disableToolCallResolution` branch (`LanguageModel.ts:1076–1080,1145–1180,1211–1229,2145–2208`). The helper calls `toolkit.handle` before the provider request. The same ordering exists in the streaming path. The controlled protocol must therefore prevent prompt-carried approval artifacts from acquiring authority or dispatching outside its owned Tool path; the flag alone is insufficient. This is a source-confirmed path, not an executed bypass reproduction or an upstream defect classification. Earlier fixtures did not exercise pending native approvals. No local upstream workaround is selected.
- **Dynamic schemas have two different contracts.** A dynamic Tool with Effect Schema parameters uses native decoding. A raw JSON Schema is advertised but `Tool.dynamic` installs `Schema.Unknown` for local parameters (`Tool.ts:1295–1438`); it is not runtime validation. The public `SchemaRepresentation.fromJsonSchemaDocument` offers an existing importer, but explicitly supports a subset with different value semantics, reference restrictions, ignored extension keywords and pattern handling (`SchemaRepresentation.ts:2831–2885`). It cannot be advertised as transparent standards-complete validation. Choose the interoperability promise first, then the smallest verified validation path; do not ask authors to duplicate schemas for ordinary Effect-Schema Tools.
- **Definition origin is not execution locality.** `Toolkit.HandlersFrom` selects handler-bearing Tools through `Tool.RequiresHandler` (`Toolkit.ts:173–181`); the native resolver skips calls based on `providerExecuted`, not solely the provider-defined Tool tag (`LanguageModel.ts:2283–2301`). A provider-defined local call with a required handler still needs the ordinary local gate. A call already executed by the Provider cannot be authorized retroactively by that gate. Merely adding a local handler does not prove that it gates every remote action; qualify each provider capability. Pre-request authorization and provider-supported deferred approval need an explicit contract, with no claim that a response marker proves permission.

The owner subsequently selected: default-loop failure on explicitly incomplete output unless the custom Agent handles it; JSON-Schema interoperability rather than treating the native importer subset as transparent validation; and explicit bounded pre-request Provider capability grants, with genuine deferral or rejection where stricter policy requires exact-argument consent. The [canonical plan](../plans/effect-native-library.md#selected-tool-variant-policies) records the remaining concrete contracts; ADR-0051 owns the grant-versus-Approval distinction. These selections are policy, not new runtime evidence. Existing whole-Turn ownership, serial local execution, fail-closed policy, selected safe native gate reporting and full replacement scope remain unchanged. Long-lived Host and durable recovery contracts remain separate work.

## Pending approval boundary check

The parent added `/tmp/mitome-approval-boundary-rc117-ejIHV7bo` to exercise the specific source finding above, without changing the historical fixtures, repository dependencies or upstream source. This is a narrow candidate check, not a full Step implementation or Session/Host integration. The later Step/application review below independently inspected its source and retained logs; it did not rerun this historical fixture.

The native control supplies an ordinary Tool handler and a Prompt containing a matching native Tool Call, approval request and approved response. Despite `disableToolCallResolution: true` and `toolChoice: "none"`, the handler runs before the fake provider request. The result contains its pre-resolved Tool result. This confirms pending-approval execution, not a violation of a proved upstream lifecycle contract or a claim that native approval artifacts authenticate Mitome permission.

A small managed-input candidate rejects native approval request/response parts before invoking LanguageModel. The same payload then enters neither the ambient handler nor the provider. An ordinary Prompt still reaches the provider and returns a newly generated Tool call without executing it. Removing only the guard fails at `checks.ts:57`: expected an empty invocation log, observed `["handler", "provider"]`.

Both the initial and parent rerun compile/runtime checks exit 0; the guard-removal mutant exits 1 at that intended assertion. `timeout 30s bash run.sh` verifies nine selected source/setup hashes before and after execution and checks all 214 Effect compiler inputs resolve exclusively to isolated rc.117. The existing compiler wrapper is unchanged; strict checking includes exact optional properties and uses `skipLibCheck`. Logs: `compile.log`, `runtime.log`, `mutant.log`, `parent-compile.log`, `parent-runtime.log`, `parent-mutant.log`, `parent-inputs.log` and the hash logs in that directory. The guard and assertions were written together; the effective mutant supplies the negative control rather than a prior failing implementation test.

The fake provider deliberately returns a new call despite `toolChoice: "none"`; this is a check of local non-execution, not provider conformance. The guard is Mitome input validation in a proposed protocol, not a patch to Toolkit or permission to strip/translate provider approval workflows blindly. No authenticated controls, provider-side deferral, generic Step signatures, real Session commit/recovery, streaming-approval integration or long-lived Host lifecycle is proved here. Those remain integration obligations before adopting the candidate.

## Step result and once-acquired application qualification

Two new isolated rc.117 checks refine the candidate contracts without changing production or historical fixtures. Workflow `d22ef839-f2b6-442e-8663-c42bb6708d65` produced `contracts/step-completion.md`, `contracts/long-lived-acquisition.md` and `contracts/review.md` under its managed output directory. Independent review found no issues **within the bounded evidence**; it inspected source/logs, did not execute tests or recompute hashes, and left full Step, transport, authenticated admission, recovery/storage and platform integration unqualified. The parent inspected consequential source/probe paths and reran both new runners successfully, separately from that review.

### Native result and completion evidence

Scratch `/tmp/mitome-step-completion-rc117-hqDnfDms` checks an original `LanguageModel.GenerateTextResponse<Tools, "encoded">` alongside separately resolved `ReadonlyArray<Response.ToolResultParts<Tools>>`. It preserves heterogeneous Tool-name/result discrimination and supplied Effect E/R. Original response identity, metadata and getters remain unchanged; local results do not appear retroactively in its getters. Native content remains mutable. Converting native HandlerResult into a discriminated response part uses one disclosed internal correlation assertion, limited to native-validated/encoded output paired with its exact Tool; it neither validates arbitrary forged output nor casts Effect requirements. HandlerResult's `failureOrigin` is not retained by the smaller native response part.

Twelve exact type assertions, six intended negative diagnostics and a focused runtime check cover encoded parameters/results, native return-mode failure data, all eight finish reasons plus absence/error parts, projection/preliminary behavior and application-error identity. The wrong explicit-unknown classification control fails as intended. Projection still accepts an unresolved Tool call by itself and drops some diagnostic parts: it cannot establish conversation validity. Earlier Tool effects remain observable after subsequent application failure, without a successful completed-result record or wrapped application error.

The parent confirmed `LanguageModel.ts:1052–1069` can retry incremental generation without incremental state on `InvalidRequestError`, and `:2232–2255` classifies explicit unknown/other as incomplete while allowing absent finish. The getter alone is insufficient. Native streaming auto-resolution may begin earlier handlers before receiving an incomplete finish; the managed no-local-dispatch policy requires classification before execution. No version-matched rc.117 provider adapter was available in the inspected installed trees; older adapters and mismatched local tests were not treated as current provider conformance. Provider pause/remote continuation therefore remains unqualified, not permission to replay.

The runner preserves first provenance-checker failures (guessed native compiler filename and virtual bundled-library paths) and an over-specific negative-diagnostic expectation; these were corrected only in scratch and were not compiler/provider fallbacks. Parent `timeout 90s bash run.sh` exited 0. Its setup/source checks cover seven setup files and 2,473 source/runtime/compiler records; all 214 Effect compiler inputs resolve to isolated rc.117. Strict exact-optional checking uses the unchanged `7.0.2+effect-tsgo.0.36.5` wrapper and `skipLibCheck`, not an upstream source build.

### Closed application callbacks and real Session ownership

Scratch `/tmp/mitome-long-lived-acquisition-rc117-UoVxCmT3` imports the unchanged actual kernel and corrected authoring fixture. The original ordinary program remains independently typed; one native infrastructure/builder acquisition yields an ordinary bound record. Invocation actually provides the acquired services and omits captured application Scope so the kernel's Turn Scope wins. Explicit Session allocation is not a memoized Layer. Observation retains caller Scope; detaching it does not own or release the application Session.

Twenty-five exact type assertions distinguish original A/E/R, acquisition E/R and callback requirements. Ten negative assignments reject erased requirements/errors and falsely closed callbacks. A separate untyped consumer reproduces `Service not found: author/App` when a function is merely acquired under provision but invoked unprovided. Six runtime groups exercise five real saved Turns on two explicit Sessions with one infrastructure/builder acquisition, idle retention, release guards, scoped acquisition unwind, body failure without commit followed by reuse, request interruption after actual app-owned admission, and shutdown that rejects new work while held Tool cleanup prevents infrastructure release. Two effective mutants remove Scope omission or admission checking. Later Turns on the same Session are text-only with this historical fake Model; this is not arbitrary repeated Tool behavior.

The launch method returns a **process-local ticket**, not a durable acceptance receipt: Busy/released outcomes can arrive on join. The checks do not establish acceptance/launch atomicity, independent concurrent-Session stress, transport/readiness supervision, dynamic loading of the acquired record, authorization, SQL durability or deadline enforcement. Acquisition failure unwind is checked inside an enclosing scoped lifetime; typed R closure is not linear lifetime safety. The historical fixture's stricter finish check is not promoted to the selected incomplete-output policy.

Parent `timeout 150s bash run.sh` exited 0, with 23 setup and 2,710 source/compiler/input hashes plus original-import hashes checked before/after. The parent also verified the frozen historical evidence manifest before rerunning. All 214 Effect inputs among 440 total compiler inputs resolve to isolated rc.117. Parent evidence is `/tmp/mitome-step-host-parent-d5IkWr8b/{step,host,host-historical-evidence}.log`; the new Host run is `logs/run-IG9tU0Pm/`. Both runners retain prior logs and verify their expected negative exits rather than treating them as passing implementations.

These results qualify components, not all candidate public signatures or a combined new Step/Host runtime. The owner subsequently selected shared read-only execution diagnostics for inspecting earlier Tool outcomes after a later failure; the canonical plan/#170 own that still-to-be-specified query contract. This is distinct from the already-selected ability to handle incomplete provider output. It authorizes neither error wrapping, successful partial publication, resumable Step handles nor replay. The new diagnostics choice itself has no runtime proof yet.

## Declarative child primitives and owner lifetimes

A new isolated probe checks a small prerequisite for #173's declaration DX: an inert heterogeneous record retains ordinary child functions, and awaited/background primitives share the unchanged real Session/Turn kernel. It does **not** yet supply the final catalog-to-Toolkit adapter or durable child operations.

The compiled low-level shape is:

```ts
const children = { summarize, audit };
const summary = yield * run(children.summarize, { text: "hello" });
const fiber = yield * start(owner, children.audit, { id: 7n });
const audited = yield * Fiber.join(fiber);
```

Here `run`/`start` are scratch helpers, not Mitome exports; the expressions belong inside an Effect program with the required services. `owner` is an explicitly captured native Scope, not a durable ownership token. The original functions remain directly callable. Selecting `summarize` requires its service, not `audit`'s unrelated service. Live Map/bigint/function results and original application-error identity survive. Optional native Tool schemas describe only explicit Model-facing result/failure projections, not automatic serialization of those direct results.

### Evidence and parent reproduction

- Original scratch: `/tmp/mitome-declarative-child-rc117-cp9nG4bK`; worker/reviewer reports are under workflow `f8751fd8-05e6-476e-ac52-9d626ce4459e`, `contracts/declarative-child-{proof,review}.md`.
- The unchanged kernel is `/tmp/mitome-session-turn-proof-rc117-20260924/proof.ts`, hash `333419fbc212a830d0fde966f65d3aabd7cb01df7c6833497de8db46972aed6e`; native Tool execution reuses the corrected registrar `/tmp/mitome-loaded-real-session-rc117-20260925/registration.ts`, hash `5085f9fc1d7c569b93776436129d9b1f6f36faa92e7deae555ac7d0ac640b73f`.
- Independent review inspected source, logs and manifest entries, but executed nothing and recomputed no hashes. Verdict: bounded proof OK with notes, no P1. It identified a duplicated input Schema and an unsupported repeat-run claim.
- Parent variant: `/tmp/mitome-declarative-child-parent-v2-v5s75wsb`. Only the duplicated text-input Schema was consolidated; compiler-path/source manifests were regenerated for the new directory. Other listed source/fixture files were checked byte-identical. Historical sources, logs and manifests remain unchanged.
- Parent process `proc_716c` ran both `timeout 150s bash <scratch>/run.sh` commands, exit **0**, followed by three retained `timeout 30s bun checks.ts` runs, each exit **0**. Records: `/tmp/mitome-declarative-child-parent-evidence-fNLLlp7X/`; original runner `logs/run-Fjy3eGmA`, variant runner `logs/run-paYFHppI`. The worker's additional “15/15” claim has no retained command/output record and is **not counted as verified evidence**.
- Both runners passed **22 exact type assertions, 12 intended type rejections, seven runtime groups and four assertion-driven mutants**. They checked 214 isolated Effect compiler inputs (440 total), 2,701 dependency/compiler-input hashes, source/fixture manifests before/after, runtime resolution, unchanged repository state and empty staging. Compiler: `bun /home/cyan/dev/github.com/chenxin-yan/mitome/node_modules/typescript/bin/tsc`, `7.0.2+effect-tsgo.0.36.5`; strict/exact-optional/unchecked-index settings with `skipLibCheck`, not an upstream source build.

### What the checks establish

- Declaration and construction do not invoke even the synchronous body of a function returning an Effect. `Effect.suspend` defers that invocation to child execution; the eager mutant fails the body-count assertion.
- Awaited and background execution use fresh child Sessions/ActiveTurns/Scopes and isolate staged history in the supplied fixture Stores. Child save waits for child cleanup. The context-bypass mutant sends staging to the wrong Turn and fails the save assertion.
- A background child launched through actual native Toolkit handling survives both the handler and a deliberately short launching Scope. Forking under the temporary handler instead of the declared owner fails the running-child assertion.
- Closing the parent Turn owner interrupts/drains unfinished children. Held child cleanup blocks parent save, settlement and reuse; closing the parent Session also waits and prevents save. Unjoined child interruption does not itself force parent failure after successful cleanup, consistent with the selected native semantics.
- An explicitly application-owned job can outlive its launching parent. Application close rejects later starts and waits for held job cleanup before releasing infrastructure. `Effect.setContext` excludes the tested launcher-only service; substituting merging `provideContext` fails that assertion.

First failed expectations are retained in `logs/dev/`: a type assertion incorrectly retained parent Scope in R, a negative used a nonexistent `Foreign.asEffect`, and a runtime assertion omitted the empty commit made by a successful probe Turn. Only new scratch code/assertions were corrected. Negative checks now fail for their intended input/service/error/return-type reasons; mutants exit 1 at assertions, not timeouts.

### Limits and next DX step

This is a **primitive and lifetime proof**, not finished declarative Model exposure. The author fixture still writes native Tool handlers, acquires its registrar per Turn and manages a process-local job map keyed by provider call IDs. That map/fallback is not an acceptable runtime or durable child-identity contract. The [subsequent optional adapter proof](#optional-child-tool-adapter-and-nested-owner-correction) removes that repetitive plumbing and corrects a newly reproduced nested-owner defect. Neither checkpoint selects public exports or durable child operations.

The raw `Scope.Scope` parameter does not distinguish parent/application ownership; closed-parent starts were not tested, and application late-start rejection was not mutation-tested. The example `acquireApp` only accepts a closed, infallible infrastructure Layer; it does not qualify the final acquisition E/R contract. `K.Store` is a fixture requirement, not a new author-facing persistence obligation.

Parent-linked mode demonstrably inherits the caller's runtime Context. `Effect.context<R>()` does not filter services, and `provideContext` merges. Application context replacement proves the tested boundary, not isolation of lexical captures, process globals or every native reference. No permission or secret-isolation claim follows. The authority fixture always allows execution, and the parent supplies separate string-history Stores without durable Transcript IDs.

The tests use two short sleeps (30 ms and 20 ms); the three logged repeat passes are bounded stability evidence, not scheduler/platform conformance. No real Provider/default-loop, durable acceptance/recovery, permission ceilings, budgets, workspace locks, Skills, transport or platform behavior was qualified. Repository dependencies remain unchanged.

## Optional child Tool adapter and nested-owner correction

The follow-up qualifies an optional native composition surface, not another Agent definition framework. The original functions remain in an inert record. The author explicitly declares native Tools, schemas and projections; small helpers generate their handlers, and native `Effect.all` combines them. No author-written launch handler, job map, raw owner Scope or per-invocation registrar is needed. Given the explicit native `SummarizeNow`, `SummarizeStart`, `SummarizeJoin` descriptors and `view` projections from the compiler-checked author fixture:

```ts
const children = { summarize, audit };
const summaries = Children.background(
  { start: SummarizeStart, join: SummarizeJoin },
  children.summarize,
  view,
);
const ChildTools = Toolkit.make(SummarizeNow, SummarizeStart, SummarizeJoin);
const childHandlers = Effect.all({
  summarize_now: Children.awaited(SummarizeNow, children.summarize, view),
  summarize_start: summaries.start,
  summarize_join: summaries.join,
});
```

These `Children` helpers are **scratch candidate names, not exports**. `audit` remains directly callable and unexposed; the selected handlers require `Summarizer`, not `Ledger`. Direct results keep their live types and identity; only Model-facing projections use schemas. Runtime/composition code binds the owner at the real Turn entry and acquires the existing registrar once per Turn. Binding pure closures per Turn is not infrastructure reacquisition. Background Tools issue UUID handles independent of Provider call IDs; native Fibers and per-owner tables implement process-local lookup/join without relaunch.

### Parent-found failure and correction

The first adapter's seven runtime groups and independent review missed a real nested case. The parent created `/tmp/mitome-child-owner-challenge-FjdKg8Wo/check.ts`, which compiled successfully and failed at the intended assertion: **`child must drain its managed grandchild before committing and returning`**. An ordinary child composed generated background handlers through the unchanged native registrar without selecting or overriding an owner. Captured parent Context retained `ChildOwner(rootScope)` while the existing kernel rebound only Session/ActiveTurn/Scope. The intermediate child therefore committed `["child"]` and returned while its grandchild remained under the root owner:

```json
{ "first": "child-returned", "childHasOwnOwner": false, "saves": [["child"]] }
```

This was a candidate-owned binding bug, not an Effect defect. The correction copies the child seam into a **new** scratch directory and provides its internal `ChildOwner` inside the existing child's `withTurn`, using that Turn's Scope. Awaited/background adapters and direct managed `run`/`start` share that seam. There is still one fresh child Session and one child Turn, no additional executor and no author-side owner provision. The author declaration remains byte-identical. The copied parent reproduction changes **only** the adapter import and now passes:

```json
{ "first": "grandchild-cleanup", "childHasOwnOwner": true, "saves": [] }
```

The corrected managed `run` has result/error/requirements `Effect<A, E | BoundaryError, Exclude<Exclude<R, ChildOwner>, Kernel> | Store>`; `start` returns the corresponding native Fiber. The internal owner requirement is removed through real provision, not a cast. Ordinary function calls keep their original requirements; outer handler acquisition still requires its owner. Exact types and negative controls reject erasing those distinctions. The fixture Store is not a new author-facing persistence requirement.

### Verified evidence

- Historical adapter `/tmp/mitome-child-adapter-rc117-8TNXTGYg`; reports under workflow `caadd42b-f785-4477-a0e2-4d7b7807ad29`, `contracts/child-adapter-{proof,review}.md`. Parent `proc_c54d` reran its suite successfully; `/tmp/mitome-child-adapter-parent-1NPjyVw4/run.log`. This does **not** override the later nested counterexample.
- Corrected scratch `/tmp/mitome-child-owner-fix-rc117-p8whSMXs`; reports under workflow `0756e68d-5f84-4973-a0d8-a16ad708339d`, `contracts/child-owner-fix{,-review}.md`. Follow-up reviewer `d9f5cd53-60d3-4237-a12f-9d11a670b271` accepts the bounded correction and explicitly supersedes its earlier no-behavioral-defect conclusion. Both reviews inspected source/logs only, without executing or recomputing hashes.
- Parent `proc_eb39`: `timeout 900s bash /tmp/mitome-child-owner-fix-rc117-p8whSMXs/run.sh`, exit **0**. Retained output `/tmp/mitome-child-owner-parent-iLdQbJRZ/run.log`; full command/diagnostic evidence `logs/run-LhZpHPiW/` in the corrected scratch.
- Preserved **22 exact assertions, 15 intended negatives, seven runtime groups and four mutants**; added **ten owner assertions, six owner/control negatives and five runtime groups**. One additional no-rebind mutation is exercised twice: the parent reproduction's ordering assertion and an intermediate-premature-commit assertion. These are five distinct mutations, not six. The unchanged original reproduction still fails; the import-redirected copy passes. All expected mutant failures exit **1** at their intended assertions, not timeouts.
- Nested checks cover awaited/background intermediate Tools and direct managed `run`/`start`. Held descendant cleanup blocks intermediate commit, return and reuse; after release, `cleanup-end < child-save < return`. Each intermediate gets a distinct Session/owner matching its own Turn Scope. These new adapter/owner suites use Deferred handshakes, not sleeps.
- The runner verifies **266 historical fixture entries**, **2,701 dependency/compiler entries**, candidate source manifests before/after, 214 isolated Effect inputs (447 compiler inputs total), exact source-copy deltas, unchanged repository state and empty staging. Native kernel/registrar hashes remain those recorded above. The approved compiler/version and strict consumer settings remain unchanged; no dependency update or upstream source-build qualification occurred.

Initial compiler errors and unsuccessful mutant attempts remain in `logs/dev/`. An early no-rebind mutant reportedly timed out because its failure path did not release held cleanup; that empty log does not independently establish exit 124. The corrected failure path releases cleanup and its assertion/exit 1 are retained and parent-reproduced. The historical report's unretained Equal-helper sanity claim is not retroactively accepted: two actual superset/subset negative controls now supply separate retained evidence. The older suite still passing with rebinding disabled is preserved as evidence of the original coverage gap.

### Remaining gates

This qualifies the shown declarative adapter and bounded ownership correction, not the whole #173 runtime. Owner placement remains trusted native composition, not a security capability. Parent Context still inherits service references; only the managed owner and kernel services are rebound. No permission or secret isolation follows.

The schema examples are service-free; serviceful schemas/Tool dependencies, throwing projections, output-encoding failures and the post-fork closure race remain unqualified. Refusal variants use native AiError text, not a selected typed control protocol. Handles are non-authenticating, process-local and owner-bound; lookup requires an active owner, entries remain with the binding, and no capacity, deduplication, cross-Turn retrieval or durable acceptance is established. Repeated Provider call IDs in the fixture test identity separation, not legitimate duplicate admission. Application-owned acquisition E/R and the earlier job-lifetime gate are not requalified by this fix. Authority, budgets, workspace handoff, durable recovery, Provider/default-loop integration, transport and platform checks remain necessary. No production code changed.

## Raw-schema validator selection: security constraints

This is a documentation/source checkpoint, not a selected dependency or executed validator proof. The parent found no direct `ajv`, `ajv-formats`, `jsonschema` or `@hyperjump/json-schema` dependency in the root/package manifests or lockfile, and no top-level installed Ajv package. Existing Effect importer limitations above still apply; this is not permission to install another package.

Ajv is one candidate, not yet a recommendation qualified against an installed version. Its [official dialect documentation](https://ajv.js.org/json-schema.html#json-schema-versions) distinguishes draft-07 from draft-2020-12 and requires separate instances for 2020-12 versus earlier drafts. Its [security guidance](https://ajv.js.org/security.html#untrusted-schemas) treats schemas as trusted application code by default and warns that untrusted schemas can exhaust compilation/validation resources. The same guidance documents exponential regular-expression cost even for relatively short strings, warns against production `allErrors: true`, and notes that replacing JavaScript regex with a linear-time engine can change syntax and semantics. A schema-size cap is therefore not a complete safety claim, and silently switching regex semantics would violate the selected interoperability policy.

Before selecting a validator, specify supported dialects and absent-`$schema` behavior; reference resolution without unsolicited network access; format/extension handling; validation without coercion, default insertion or property removal; schema/data resource limits and the actual enforceable execution boundary for untrusted validation. Distinguish native Effect-Schema declarations and trusted module initialization from remotely supplied raw schemas. Any unsupported feature must reject before use rather than be silently weakened. These are qualification obligations, not a claim that an in-process timeout can stop synchronous work or that another validator has already solved them. No universal JSON-Schema support, runtime/platform qualification or validator dependency is selected here.
