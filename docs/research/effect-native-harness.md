# Effect-native harness research record

Status: **historical evidence, not the canonical plan or an API specification**. The accepted direction and remaining proof/implementation gates now live in the [library plan](../plans/effect-native-library.md); [ADR-0057](../adr/0057-use-effect-native-functions-and-optional-host-composition.md) records the architecture decision, and [#174](https://github.com/chenxin-yan/mitome/issues/174) owns delivery. All sketches, delivery sequences and backlog treatments below are research-time snapshots; consult those canonical sources for current policy. Exact signatures remain unverified and the current implementation remains Promise-facing. The cleanup records decisions, not production implementation.

## Scope and evidence

Inspected Mitome at `c343410` and installed Effect `4.0.0-rc.108`. Three parallel research lanes covered implementation, roadmap/ADRs, and version-matched Effect sources. No implementation or integration tests were run. Illustrative APIs discussed in chat are proposals, not existing exports.

## Findings

- Mitome's canonical execution engine already uses Effect, Stream, Scope, Layers, and Deferred-based approvals. The root SDK adapts Promise authoring and consumption to that engine. An Effect-only pivot changes public composition and removes adapters; it does not require replacing a Promise-based execution engine. See [Session](../../packages/core/src/session/session.ts), [Effect exports](../../packages/sdk/src/effect.ts), and [Promise Session adapter](../../packages/sdk/src/session.ts).
- Host contracts are still Promise-facing (`run`, `handle`, `serve`), including on the Effect SDK export surface. Making the whole authoring surface Effect-native must address them too. See [Host](../../packages/core/src/host.ts).
- Effect already supplies service injection, scoped acquisition, concurrency, interruption, schemas, model operations, tools, and tool-handler Layers. A service dependency is not automatically a model-visible tool. See version-matched [Context](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/packages/effect/src/Context.ts), [Layer](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/packages/effect/src/Layer.ts), [Tool](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/packages/effect/src/unstable/ai/Tool.ts), and [Toolkit](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/packages/effect/src/unstable/ai/Toolkit.ts).
- `LanguageModel` supports native generation/streaming and `disableToolCallResolution` for application-owned tool execution. Upstream tool approval parts provide a protocol, not an authenticated human decision service or a security sandbox. See [LanguageModel](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/packages/effect/src/unstable/ai/LanguageModel.ts).
- Upstream Chat is not equivalent to Mitome Session. In rc.108, `Chat.streamText` writes accumulated response parts to history in its release callback; Mitome commits history only after successful Turn completion and transcript save. Reusing Chat as the history authority requires explicitly reconciling those semantics. See [Chat, makeUnsafe](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/packages/effect/src/unstable/ai/Chat.ts#L408-L480) and [Mitome Session](../../packages/core/src/session/session.ts).
- Layer memoization is scoped to a memo map and Layer identity, not a global singleton guarantee. Session isolation and deliberately shared provider clients still need an explicit ownership model. See [Layer](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/packages/effect/src/Layer.ts).
- Ordinary Effects/fibers/retries do not provide process-crash recovery. Effect's workflow APIs offer activity/result and deferred coordination, but `WorkflowEngine.layerMemory` explicitly is not a durable backend. Persisted history is not recovered execution, and recorded outcomes do not guarantee exactly-once external side effects. See [WorkflowEngine](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/packages/effect/src/unstable/workflow/WorkflowEngine.ts#L647-L663) and [ADR-0056](../adr/0056-separate-history-compaction-and-execution-recovery.md).
- An Effect-native contract can exclude Promise-first agent APIs and SDK adapters while allowing unavoidable foreign I/O interoperation at platform edges. Native provider implementations should be preferred over wrapping Promise-first model SDKs.

## Existing direction being reconsidered

[Roadmap #174](https://github.com/chenxin-yan/mitome/issues/174) targets embedded use and a local coding Agent, with history, compaction, recovery, controls, Skills, and subagents. Its contracts remain design work. The former ignored `.plan/effect-di-refactor.md` was an internal provider-boundary proposal against Effect beta.102 with zero public API impact; it was deleted during cleanup because the accepted public pivot supersedes that scope. Its provider-I/O observations require revalidation against the installed version, not adoption as a second plan.

- At research HEAD, [ADR-0015](https://github.com/chenxin-yan/mitome/blob/c343410/docs/adr/0015-publish-a-promise-first-sdk-as-the-default-surface.md), [ADR-0045](https://github.com/chenxin-yan/mitome/blob/c343410/docs/adr/0045-keep-the-promise-surface-effect-free.md), and [ADR-0047](https://github.com/chenxin-yan/mitome/blob/c343410/docs/adr/0047-curate-entry-points-by-audience.md) deliberately selected Promise-first public authoring and separate audiences. The cleanup supersedes that policy through ADR-0057; these are historical links.
- Historical [ADR-0041](https://github.com/chenxin-yan/mitome/blob/c343410/docs/adr/0041-remove-extension-dependency-injection.md) and [ADR-0053](https://github.com/chenxin-yan/mitome/blob/c343410/docs/adr/0053-keep-extension-resources-private-eager-and-definition-ordered.md) reject a custom cross-Extension dependency graph with no demonstrated non-test consumers. This is evidence against rebuilding DI, not against ordinary Effect dependencies.
- Existing lifecycle, approval, and persistence invariants must be evaluated separately from obsolete authoring syntax; not all existing ordering/privacy rules are automatically requirements for the new design.

## User-selected direction so far

The user confirmed these architectural decisions; exact APIs remain open:

1. Provide a composable harness AND independently usable primitives/tools for personal agents, coding agents, and in-memory library use.
2. Permit a clean break from existing definitions, extension APIs, and host contracts; do not require compatibility adapters.
3. Offer recovery at explicit durable operations, not automatic replay of arbitrary user Effects.
4. Keep service injection separate from explicit model-visible tool selection.
5. Share conversation state through an explicit Session scope, not implicitly through an agent function or global Layer.
6. Represent a run as an Effect yielding its result; provide progress events separately.
7. Allow fully replaceable loops written in ordinary Effect code using shared operations.
8. Author tools/models using native Effect AI types, rather than duplicate Mitome representations.
9. Retire Extension as a required framework object; reusable packages export ordinary tools, Layers, and composition functions.
10. Give delegated agents fresh child Sessions by default; history forks are explicit.
11. Reject concurrent Turns on the same Session rather than queueing or branching automatically.
12. Keep progress observers passive: observer failures/disconnections do not control execution. Bound progress buffering; approval resolution and durable recording use separate authoritative paths.
13. Cancel delegated children with their parent by default; independently surviving work requires a separately owned job.
14. Keep committed conversation history separate from unfinished execution. A failed Turn does not commit partial conversation or imply rollback of completed external Tool effects.
15. Deliver only the library and CLI/TUI. A coding agent is a user-defined composition built with the library and loaded into the CLI/TUI, not a separate required product. They share the same execution implementation. The loadable module contract remains to be designed.
16. Reassess valuable existing concepts before removing their authoring machinery. The user requested a review of prior concepts; earlier proposals to remove mandatory definition/extension objects do not justify discarding their useful semantics.
17. The user-loaded module owns provider/model configuration and persistence. CLI/TUI supplies interaction and invokes the supported capabilities; it does not become a second source of agent configuration.
18. Provider discovery/authentication must be available independently of opening a live Session or acquiring authenticated model resources. Layers provide infrastructure; an agent need not itself be a Layer.
19. The same user-authored agent composition must be importable and runnable programmatically in application code, without launching or importing CLI/TUI and without a second agent definition or Promise adapter API. The contract is host-neutral; CLI/TUI is one consumer. Applications explicitly provide any required interaction/approval services. Individual agent programs and primitives remain directly composable as Effects.
20. User-authored agents may return their own typed results independently of conversational messages and TUI presentation. The programmatic API must preserve the specific result type.
21. Canonical authoring is an ordinary Effect-returning function with Session as an ambient Effect dependency. No mandatory `createAgent`, per-agent service token, or Layer-valued agent definition. Agent-specific tokens remain an optional app-level DI technique; a fixed key still cannot be specialized by merely providing a Layer.
22. One agent invocation is one managed Turn, even when the program performs multiple model generations. The app/CLI owns the Turn boundary; messages are staged and committed after successful program completion and durable save. Proposed spelling: `programEffect.pipe(session.withTurn)`, with the equivalent direct-call form supported by the same unary combinator. Exact name/implementation remain open. Completed external effects are not rolled back by Turn failure.
23. Configuration over convention: reject CLI discovery through magic named exports such as `agent`, `layer`, `providers`, or `sessionOptions`. Consume one explicit typed composition value referencing the user program and native infrastructure. Host integration is optional for ordinary library use, not required agent authoring or a Promise adapter. The user has requested generalizing the CLI-only proposal to declarative, composable Hosts (TUI, HTTP, later messaging gateways); exact helper name/shape remain proposed.
24. Initial usable redesign delivers TUI and HTTP Hosts. Design the gateway seam now; Discord and Telegram integrations follow in later phases. The Host/composition-root comparison against current Mitome and Alchemy at commit `645334b388f6b56ca0d464910a79f034d4fcda2a` is complete.
25. The user accepted the high-level Host architecture below and retained `defineMitome(...)` rather than `new Mitome(...)`: declare a composition value; acquire runtime resources through explicit Effect operations. Concrete signatures remain subject to proof.
26. Retain #174's full replacement milestone: durable recovery, History trees, Compaction, Skills, controls, and subagents remain acceptance gates. A process-local TUI/HTTP slice is an internal proof, not an approved smaller public release. Host scope selection did not reduce the library feature requirements.

## Current DX review

The user accepted the broad goals but objected to mandatory `createAgent` and `runLoop` entry points in the first end-to-end sketch. The priority is an intuitive, low-friction experience for authors already familiar with Effect—not merely Effect types around a conventional agent framework. Renaming helpers alone would not address that objection.

A fresh primary-source Effect best-practices investigation and a forked Oracle consultation (initial opinion plus one evidence follow-up) are complete. Both recommend an ordinary Effect-returning function as the canonical agent program, with Layers supplying dependencies and a Session supplied to the program. The user selected function-first authoring with an ambient Session dependency after this review. Mandatory agent Layer export and per-agent token are no longer the default direction. No implementation is authorized. Native Effect supports this form; it is a design recommendation, not an official rule forbidding service-based agents.

Success criteria for the next DX proposal:

- An author can identify which code is their agent behavior and compose it using ordinary Effect constructs.
- The same composition works in application code and CLI/TUI, without a parallel implementation.
- Custom result/error/dependency types remain sound without mandatory casts or duplicate type declarations.
- Discovery/authentication, scoped state, approval control, history commits and optional durability have explicit owners, even if their machinery is hidden behind a small interface.
- Every Mitome-specific operation earns its place by supplying agent semantics rather than repackaging native Effect composition.

### Parent synthesis of the second opinion

Recommendations adopted for the revised function-first direction:

- Remove mandatory agent-to-service packaging. A statically imported Effect-returning function already carries its result/error/requirement types; no per-agent token is needed merely to preserve those types. Tokens remain optional when an application genuinely wants dependency substitution.
- Use Layers for shared implementations and resource acquisition rather than requiring every agent program to become a Layer. Keep Session allocation explicit and scoped.
- Preserve an explicit loadable CLI composition root: callable program, author-supplied infrastructure, and offline discovery metadata. The user rejected automatic discovery from named module exports; prefer one typed configuration value. The CLI cannot infer capabilities from an opaque function. Provider descriptions must remain a single source used by both discovery and runtime provisioning.
- Mitome still needs an execution operation for controlled model/tool work and Session semantics. Removing `createAgent` packaging is a real simplification; renaming `runLoop` is not enough. Familiar generation names are candidates only if their Step/Turn and commit semantics are documented clearly.
- An ambient Session requirement and an explicit Session parameter are both native choices. Ordinary nested function calls share the supplied Session; fresh subagent delegation is a distinct explicit composition, not an automatic consequence of calling a function.

Corrections/limits on advisory sketches:

- Oracle's `Layer.scoped(...)` sketch is not valid rc.108 API. The installed source exposes `Layer.effect`, which removes acquisition-time Scope requirements. No Session Layer implementation is adopted; a scoped constructor remains the simpler candidate.
- Oracle's sample instantiated provider definitions twice; do not adopt that duplication. Discovery and provisioning should reference the same definitions.
- `Session.generateText/generateObject`, `Session.isolated`, and lower-level step/commit operations are proposed, not verified exports. Reusing names does not prove tool-loop behavior or whole-program transaction semantics. A result Effect plus passive observation remains the goal; no stream-driven execution API has been newly accepted.
- Layer memo maps can share a previously built Layer through nested provision. A reused Session Layer is not proof of fresh state. Runtime isolation, cancellation, and release still need tests.

Evidence: installed [Effect function documentation](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/packages/effect/src/Effect.ts), [Context](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/packages/effect/src/Context.ts), [Layer](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/packages/effect/src/Layer.ts), and [Chat](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/packages/effect/src/unstable/ai/Chat.ts). Research run `04de7a5d-4830-4f25-bffb-55bfbc1f3921`; forked Oracle initial `1c946178-0fed-4f65-8bcf-d2acca02739a`, evidence follow-up `138929ea-ecd3-4abc-baf9-9e12cfb79188`. These passes were read-only, without a new runtime prototype.

### Comparison checkpoint

Before committing to function-first authoring, the user requested a balanced comparison with the earlier mandatory agent service/object design and a realistic coding-agent example. Both designs can be Effect-native, preserve typed results, share one runtime, and support the same safety/history semantics. The tradeoff is where the interface is packaged: a standard injectable agent capability versus directly imported typed functions plus explicit host configuration and Session ownership. Function-first reduces mandatory authoring ceremony, but does not eliminate the CLI protocol, lifecycle coordination, or controlled model/tool execution. No implementation or git commit is authorized by this design checkpoint.

### Selected Turn-boundary semantics

The user requested an expanded, simple end-to-end DX explanation. It must not hide a gap in the advisory sketches: if an agent program performs several generations or fails after one, automatically committing inside each generation is not the same as committing the whole invocation.

The user selected a host/app-owned whole-invocation Turn boundary, illustrated as `session.withTurn(programEffect)`: bind the Session and active Turn context, reject concurrent Turns, stage messages, execute the arbitrary typed Effect, then save/commit on successful completion. This resembles a native Effect transaction combinator in shape (`SqlClient.withTransaction` exists in rc.108), but cannot undo filesystem/network effects. This is a meaningful domain operation, not mandatory agent packaging. Exact naming, lower-level generation operations, and lifecycle/type guarantees still require validation; the selected semantics do not authorize implementation.

## Proposed interpretation

An agent program can be an ordinary function returning an Effect. Dependencies describe capabilities; Layers acquire implementations; explicit toolsets describe model exposure; a Session owns conversational state. Mitome supplies a default loop assembled from the same operations custom loops use. No separate dependency-resolution language is inherently required. Whether a small loadable Agent Definition or reusable Extension composition remains useful is being re-examined against existing CLI/TUI requirements; ordinary Effect execution alone does not settle that contract.

This does not yet settle exact public names/types, operation interception APIs, progress coalescing/overflow details, default-loop result shape, or the durable execution backend and reconciliation contract. These require a narrower API or durability design pass. The user requested concrete API design next, not implementation.

## Reassessment of prior concepts

The follow-up review separates domain semantics from mandatory authoring wrappers:

- **Loadable composition root:** preserve explicit user-module selection and an inspectable CLI contract. Current CLI authentication reads configured Providers independently of running a Turn ([auth host](../../packages/cli/src/hosts/auth-host.ts)); an opaque Effect alone cannot expose that metadata. The exact native Layer/service or plain-module representation remains open.
- **Provider and Model:** preserve authentication, catalog hints, default/selected models, and qualification. Supplying a `LanguageModel` implementation alone does not replace those features. See [ADR-0029](../adr/0029-register-providers-and-select-models-by-qualified-id.md).
- **Reusable features:** preserve the ability to compose related tools, instructions, resources, and behavior. Ordinary modules/functions/Layers can provide this without a mandatory Extension object; no need to discard the use case or force all configuration into services.
- **Instructions and Model Prompt:** preserve ordered static instructions, explicitly selected file discovery, and distinct ephemeral per-Step shaping. Prompt projection also needs branch-compatible compaction. These are domain policies, not DI behavior. See [ADR-0024](../adr/0024-compose-instructions-from-plugin-fragments.md).
- **Session/Turn/history/control:** preserve their semantic roles. The actual [TUI session manager](../../packages/tui/src/session-manager.ts) and [view model](../../packages/tui/src/view-model.ts) consume session opening, history, transcript selection, progress, approval resolution, and interruption. A final-answer Effect alone does not supply the entire interactive contract.
- **Host:** retain the separation between agent behavior and its human-facing consumer. A Host interface need not be mandatory for embedded users. Two deliverables does not by itself decide whether library support for additional surfaces should be removed.
- **Approvals:** preserve explicit author policy and fail-closed behavior. In installed rc.108, upstream `LanguageModel.isApprovalNeeded` ends with `Effect.orElseSucceed(constFalse)`, which recovers typed failures as no approval needed. The later [rc.117 audit](native-generation-boundary.md) confirms that fallback but distinguishes it from defects and from a reproduced unauthorized execution. This is an upstream behavior to flag, not a reason to duplicate Tool types or silently add a monkey patch. The supported `disableToolCallResolution` option permits an application-owned execution policy; selecting that path and its precise semantics is separate design work. See [ADR-0051](../adr/0051-let-the-agent-author-decide-tool-approvals.md) and [pinned LanguageModel source](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/packages/effect/src/unstable/ai/LanguageModel.ts).
- **Skills, steering, subagents, branches, compaction, recovery:** retain the use cases under the library + CLI/TUI boundary. Their open roadmap contracts are not supplied automatically by native Effect syntax, nor does retaining them make a separate coding-agent product.

Recommendation: preserve these domain capabilities while replacing redundant runtime/DI/adaptation machinery. Do not treat earlier illustrative `Agent.loop`/`Session.fresh` syntax as a complete loadable-agent or TUI contract.

## Typed result feasibility

This section records the earlier service-based probes. The subsequent function-first decision supersedes mandatory agent tokens and named-export discovery; the underlying type-system findings remain useful.

Compiler-only investigation against installed Effect `4.0.0-rc.108` and TypeScript `7.0.2+effect-tsgo.0.36.5` confirmed:

- Yielding a fixed `Context.Service` returns that key's declared service shape. `Effect.provide` resolves requirements and adds Layer construction errors; it does not specialize the program's success type. A global `Agent` key returning `unknown` cannot become agent-specific merely by providing a more specific implementation.
- Among the service-based proposals tested, the smallest verified proposal was a named, per-agent `Agent` Context service token alongside the default native Layer. Application code imports both from the user module. The CLI loads the same token and Layer but consumes the host-neutral protocol without assuming the domain result type. This changes the module convention, not the runtime.
- If default-Layer-only discovery becomes a requirement, a second fixed service key can expose the same object under an intentionally widened host-neutral protocol. Native `Layer.provideMerge` retains the typed key too. This extra projection is unnecessary when the loader can read the named token.
- Native class-style identifiers carry service type metadata, so some result types can be extracted from `Layer.Success` at compile time. That does not supply a runtime key, uniquely select an agent from a multi-service Layer, or specialize an already-written consumer of a fixed key.
- Session state must be allocated by `openSession` inside the caller's Scope, not once inside the shared Layer construction. Scope is resource management, not a compile-time proof against using a released Session.
- A CLI-consumable module must satisfy program dependencies or expose a defined host requirement set; arbitrary unprovided requirements cannot be erased. Dynamic module loading still requires validation and does not inherit the proof available to a static TypeScript import.

These are proposed contracts, not implemented Mitome exports. The parent inspected the compiler probes and reran both checks: positive compiler command exited 0 with 13 exact A/E/R assertions and 12 active expected-error checks; removing those expected-error directives exited 1 with exactly the 12 intended diagnostics (wrong results/errors, missing requirements/Scope, and fixed-key result erasure). No emitted JavaScript or runtime prototype was produced.

Commands used existing dependencies, without installs:

```sh
node_modules/.bin/tsc --ignoreConfig --strict --noEmit --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext /tmp/mitome-typed-agent-rc108/probe.ts /tmp/mitome-typed-agent-rc108/exact.ts
node_modules/.bin/tsc --ignoreConfig --strict --noEmit --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext /tmp/mitome-typed-agent-rc108/rejections.ts
```

Scratch probes are temporary evidence, not repository tests. Source evidence: [Context](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/packages/effect/src/Context.ts), [Layer](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/packages/effect/src/Layer.ts), and [Effect](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.108/packages/effect/src/Effect.ts).

## Recommended Host architecture and delivery plan

Status: high-level direction accepted by the user; exact APIs and implementation authorization remain pending. Initial usable Host scope is TUI and HTTP; Discord/Telegram follow later. The full replacement milestone retains the existing library capability and durability requirements.

### Alchemy comparison

Inspected Alchemy at commit [`645334b388f6b56ca0d464910a79f034d4fcda2a`](https://github.com/alchemy-run/alchemy/tree/645334b388f6b56ca0d464910a79f034d4fcda2a). It identifies as `2.0.0-beta.79`, using Effect `4.0.0-rc.117`, versus Mitome's inspected `4.0.0-rc.108`. Borrow patterns, not unchecked signatures.

- **Borrow explicit composition and deferred acquisition.** Alchemy's [Stack](https://github.com/alchemy-run/alchemy/blob/645334b388f6b56ca0d464910a79f034d4fcda2a/packages/alchemy/src/Stack.ts) carries an Effect and configured provider/state Layers. Its [session opener](https://github.com/alchemy-run/alchemy/blob/645334b388f6b56ca0d464910a79f034d4fcda2a/packages/alchemy/src/Alchemist/Session.ts) builds shared services in a Scope. Mitome can similarly declare its composition without opening Sessions, models, listeners, or a terminal.
- **Borrow a single explicit entry value.** Alchemy's `importStack` in that session module validates a selected module's default export. A selected module with one typed default configuration is compatible with the user's preference; scanning magic named exports is not. A default export is a documented loading protocol, not automatic feature discovery. Module import still executes trusted user code; this is not a sandbox.
- **Keep platform lifecycle outside agent behavior.** Alchemy's [CLI execution](https://github.com/alchemy-run/alchemy/blob/645334b388f6b56ca0d464910a79f034d4fcda2a/packages/alchemy/src/Cli/exec.ts) owns platform acquisition and development supervision. Mitome's optional runner should likewise own transport startup, not define agent behavior.
- **Do not copy deployment machinery.** No resource graph, cloud bindings, stack references, plan/apply engine, or deployment reconciler. This does not remove Mitome's independently required provider/auth metadata, Transcript storage, or explicit durable execution.

### Composition and ownership

Keep the existing `defineMitome` concept, but evolve its contents to plain programs and native Layers rather than introduce a parallel `defineCli` format. The helper is optional Host composition, never mandatory agent packaging. These field names are illustrative, not implemented:

```ts
export default defineMitome({
  program: fixCode,
  infrastructure,
  providers,
  session: sessionDefaults,
  hosts: [tui(), http({ name: "api", auth: authenticate })],
});
```

All referenced values are explicitly imported user/library values. `providers` is the same descriptor set that `infrastructure` uses for runtime provisioning, not another provider definition or a separate default model. Discovery/auth can inspect/acquire only the capabilities they need without building the entire runtime. Persistence implementations belong in the user composition. Shared Session defaults are likewise declared once and reused by embedded callers.

An embedding application imports `fixCode`, infrastructure, and Session defaults directly; it need not import the Host entry point or any TUI module. Inside its own scoped Session it invokes `fixCode(message).pipe(session.withTurn)`. It explicitly supplies consent/interaction where required. No second agent implementation, Promise adapter, or mandatory agent service token is introduced.

| Boundary                        | Owns                                                                                                             | Does not own                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Agent function                  | Behavior, explicit model-visible tools, arbitrary typed result                                                   | Transport startup or hidden Session allocation    |
| Native infrastructure Layers    | Models, handlers, stores, shared resources                                                                       | Automatic model-visible tool registration         |
| Session/Turn implementation     | Staged conversation, whole-invocation commit, busy/released checks, controlled execution, authoritative controls | Rollback of completed external side effects       |
| Shared routing support          | Authorized conversation mapping and logical-route admission before history load                                  | HTTP status codes or platform reply formatting    |
| Host                            | Transport authentication, input/output mapping, interaction, transport resources                                 | Another model/tool loop or provider configuration |
| Optional runner / embedding app | Build shared infrastructure, select Hosts, own scopes and shutdown                                               | A second runtime or inferred agent configuration  |

Hosts retain distinct capabilities: interactive execution, a mountable HTTP handler, and long-lived gateway serving. Those operations become Effect-native; do not erase their lifetime differences behind one universal `run`. Foreign Promise callbacks remain confined to actual platform edges, not a second public agent API. A gateway may expose HTTP/webhook handling, a long-lived connection, or both.

Build shared infrastructure once per application Scope. Allocate fresh Sessions explicitly, not in a memoized shared Layer. HTTP remains mountable in an existing application; Hosts do not require CLI registration. For the CLI, preserve explicit `--use`, ordered interactive fallback/non-TTY printing, and `serve` for declared Channels. Declaring a Host does not start it.

### Invariants and intentional behavior changes

- Authenticate before route/history/model access. Default external routing separates channel, authenticated Principal, and conversation. Explicit authorization is required to share across principals or Hosts. Approval/cancellation/result retrieval must check ownership; an ID alone is not authority.
- Reject simultaneous Turns on one Session, and separately reject competing requests for one logical Route before opening/loading independent Sessions. In-memory admission is only single-process exclusion.
- One invocation can contain many generations but commits once after successful execution/save. A later route update, record append, or delivery failure must not masquerade as rollback or trigger automatic reinvocation. Current HTTP already attempts route advancement in its post-commit StoreError path; route advancement is not exclusively tied to its completion frame.
- Slow progress consumers currently backpressure HTTP execution, and disconnect currently interrupts it. These are confirmed mismatches with the selected passive-observation direction, not behavior to preserve. Bound/coalesce progress and signal gaps; keep approvals, accepted work, and commit outcome authoritative outside that channel.
- Proposed hosted execution ownership: accepted work belongs to the application execution scope; a connection owns only observation. Disconnection detaches observation, while an authorized cancel operation interrupts work. Direct embedding follows caller scope. Without durable storage, process exit still ends work and loses process-local outcomes. Completion retrieval and retention need an explicit bounded contract before claiming the HTTP migration complete.
- Author policy decides allow/ask/deny; Hosts resolve permitted asks. Missing consent denies. Use a fail-closed controlled execution path with native Tool types; do not inherit upstream rc.108's approval-predicate error fallback as Mitome policy. Arbitrary user Effects are not sandboxed.
- Preserve useful existing runner supervision: startup failure unwinds acquisition; report an individual serving Host's failure while healthy Hosts remain; no implicit restart loop. Stop admission on shutdown, then cancel owned ephemeral work and await bounded cleanup. Shared infrastructure failure cannot be treated as an isolated transport failure.
- Generic application results stay typed in process. HTTP must require an explicit Schema/encoder when publishing them; never automatically serialize arbitrary values. TUI can display conversation/progress independently of that result.

### Delivery sequence and acceptance gates

1. **Prove contracts before rewriting.** Validate exact `A/E/R` preservation through Session/Turn/config composition on installed Effect. Missing dependencies must fail compilation; dynamic modules need independent shape/version checks. Discovery/import must not acquire model clients, Sessions, terminals, or listeners. Finalize Session defaults, platform requirements, and consent ownership.
2. **Establish the shared function-first execution path.** Use native model/Tool types with Mitome's controlled policy and staged conversation semantics. Test two generations followed by failure, save failure, one successful commit, busy/released behavior, fresh Sessions, interruption/finalization, fail-closed approvals, and passive bounded observation. No duplicate loop per Host.
3. **Migrate composition, embedded use, and CLI/TUI.** Revise the existing definition/loader, not a new config system alongside it. Count infrastructure acquisition once; retain exact embedded results, offline auth/catalog behavior, TTY fallback, lazy terminal imports, history/session switching, and controls. Remove superseded Promise/Extension authoring machinery rather than add compatibility layers.
4. **Migrate HTTP through the same boundary.** Retain authentication-first, principal isolation, size limits, sanitized errors, route exclusion, and persistence tests. Replace disconnect-cancels tests with observation-detach and explicit-cancel tests. Verify mountability without CLI, outcome retrieval after observer loss, and committed-save/failed-route-update handling. This and TUI form an internal end-to-end proof slice, not completion of the full replacement milestone; explicitly label its durability level.
5. **Complete separately scoped capabilities.** Keep instructions/projection, provider selection/auth, Skills, steering, parent-linked isolated delegation, branches/compaction, and explicit durable operations on the library roadmap. Recovery must prove durable acceptance, redelivery handling, persisted approvals/cancel, and uncertain external-outcome reconciliation; no arbitrary Effect replay or exactly-once side-effect claims. Discord/Telegram are later optional integrations over the proven shared boundary, not new products or core dependencies.

Smallest useful proof: one ordinary typed function, two fake-model generations, one explicitly opened Session, one store, and direct plus HTTP invocation. Prove transaction boundaries and passive observation before investing in a general Host framework. The user confirmed that process-local proof alone does not satisfy the full replacement release gates.

Still open: exact generic configuration/Host signatures, HTTP result encoding and outcome retention, and the detailed feature contracts tracked in #170–#173. Proposed defaults are explicit opt-in result encoding and process-local proof first. Durable recovery remains a full-replacement release gate. At this research checkpoint, no implementation or accepted ADR/roadmap change had been performed.

Research workflow: `2f9b6ebe-fbb1-4ce5-9407-863713622602` (Alchemy scout, current-Host scout, synthesis). Parent verified central Alchemy Stack/loading examples and Mitome Host/HTTP/supervision sources. Parent corrections: one typed default export is allowed; embedded apps need not import Host modules; Alchemy's loader check is in `Alchemist/Session.ts`, not `Entrypoint.ts`; historical token probes are not the current authoring recommendation.

## Backlog reconciliation checkpoint

Read-only audit of live GitHub issue bodies, comments, states, native blockers, and #174's sub-issues found seven open issues (#168–#174). GitHub remains the delivery source of truth; this is a proposal for revising it, not a second roadmap. No issue bodies, labels, dependencies, or states were changed.

| Existing issue                           | Proposed treatment                                                                                                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #174 roadmap                             | Revise in place for Effect-native library + CLI/TUI. Retain the full replacement acceptance gates; coding-agent use is a user composition and dogfooding scenario, not a third product. |
| #170 persistence/history/recovery design | Retain as foundational design; reconcile whole-function Turns, explicit durable operations, identities, and crash guarantees. No arbitrary Effect replay.                               |
| #168 Core Compaction                     | Retain projection, branch-validity, staged/committed-state and save guarantees; replace mandatory Extension/Hook-specific prescriptions.                                                |
| #169 public Compaction API               | Rewrite the Promise/Extension-specific surface while retaining replaceable functions, useful defaults, manual operation, and documentation.                                             |
| #171 controls                            | Retain steering, queues, and budgets; reconcile native Effect execution, authoritative controls, and persisted accounting.                                                              |
| #172 Skills                              | Retain compatibility, discovery, loading, and trust decisions; revise Extension-dependent ownership.                                                                                    |
| #173 subagents                           | Retain isolation, permissions, budgets, and recovery; incorporate fresh child Sessions and parent-linked cancellation.                                                                  |

No wholesale merger or closure is justified by the audit. Obsolete API requirements should be retired without discarding useful behavioral requirements. #166 (Model context-window metadata) and #167 (explicit instruction-file base) are closed and have corresponding current code; preserve/reuse that work. #138 (Telegram) is closed as deferred, with a maintainer comment pointing to prior work on `feat/channel-telegram`; inspect it when that later integration is scheduled, not now.

Native blockers already encode #170 → #168 → #169, plus the completed #166 prerequisite for #168. #170–#173 are decision issues, not ready-to-run implementation specifications; their absence of native blockers is not proof that implementation is ready. Add precise implementation dependency edges only after the contracts settle.

Next flow: reconcile accepted domain/ADR changes and the existing map; resolve remaining foundational questions through focused grilling and bounded proofs; consolidate into a specification; revise/split tickets into self-contained vertical slices with native blockers; implement ready slices in fresh sessions. Do not run incoming-issue triage on this owner-authored planning backlog or create a competing roadmap. Preserve this design context through specification and ticket planning.

The user explicitly chose to keep the full milestone, rather than introduce a smaller public release first. This resolves the release-scope question previously left open in the Host synthesis.

## Verification limits

The parent checked the central Session/Host sources, installed Effect version, Toolkit handler/Layer signatures, model tool-resolution option, Chat stream finalization, and workflow memory-backend warning. The Effect researcher also inspected version-matched upstream provider sources; its provider examples were not integration-typechecked. No end-to-end cancellation, approval recovery, provider parity, or production durability guarantee has been established. No roadmap issues or accepted ADRs were changed during the research pass. The subsequent authorized documentation cleanup is recorded in ADR-0057 and the canonical library plan; this record does not report the current tracker state.
