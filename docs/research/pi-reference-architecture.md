# Pi reference architecture for the Effect-native redesign

Status: **source-backed comparison, not implementation approval**. The owner requested this review before more contract questions. The [canonical plan](../plans/effect-native-library.md) still owns Mitome's design; this note explains which Pi patterns support it and which requirements deliberately differ.

## Evidence and version boundaries

- **I**: installed `@earendil-works/pi-coding-agent` **0.87.1**, at `/nix/store/q9gk8vgqbcs39yd3q0a8y48rdz53rmbw-pi-coding-agent-0.87.1/lib/node_modules/pi-monorepo`.
- **C**: installed `@earendil-works/pi-agent-core` **0.87.1**, at `I/node_modules/@earendil-works/pi-agent-core`. Its TypeScript source is available; ordinary coding-agent evidence uses installed JavaScript and declarations.
- **O**: complete `.agent-sources/pi-mono` checkout, **v0.85.1**, commit `d981de1229ef899957bbe968bc8dcda02a21f477`. The parent verified its commit, tag and clean status. Server/SQLite findings below are explicitly from this older version, not an assertion about installed 0.87.1 server behavior.

Three read-only investigations were independently reviewed. The parent inspected the consequential source paths and corrected the findings below. This is static source/test inspection: **no Pi runtime, recovery, platform or power-loss tests were executed**. One implementation is useful precedent, not evidence of an industry-wide standard or proof that every choice is correct.

## Three distinct Pi layers

| Layer                                                            | What the inspected implementation owns                                                                                     | What must not be inferred                                                                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Ordinary agent-core `Agent` / loop                               | Model–Tool sequencing, mutable live messages, queues, cancellation and event delivery                                      | Durable acceptance, arbitrary program continuation or passive observer isolation               |
| Ordinary coding-agent `AgentSession` / `SessionManager`          | Coding-agent composition, finalized-message history, tree navigation, Compaction, resources and UI/RPC integration         | Recovery of an interrupted Tool simply because a conversation can be resumed                   |
| Separate `AgentHarness`, Session storage and experimental server | Explicit operation state, Tool replay classification, transactional storage abstractions and separately hosted attachments | That ordinary coding-agent automatically uses this path, or that its guarantees match Mitome's |

This distinction matters more than matching Pi's class or method names.

## Reuse: the small execution loop and explicit safe points

The ordinary core loop prepares a request, projects model context, generates an assistant response, validates/prepares and executes Tools, appends results, then checks continuation and queued input. Steering is consumed at explicit boundaries after the current response/Tool batch; follow-up is considered when the loop would otherwise stop. A truncated assistant response does not authorize execution of potentially truncated Tool arguments. See `C/src/agent-loop.ts:162–319,376–417,703–770`.

Useful Mitome adaptations:

- One controlled execution path shared by default and custom loops; no second engine for a Host.
- Schema validation and policy checks at Tool execution, not scattered through UIs.
- Derive the Model Prompt from authoritative history; keep ephemeral request shaping separate.
- Give steering and follow-up distinct, explicit consumption points. Do not invent mid-Tool argument mutation.

Translate the vocabulary: Pi's `turn_end` follows a generation and its Tool batch (`agent-loop.ts:244–293`); Mitome's **Step** is one generation and **Turn** is the entire managed program invocation. Pi's callback is not Mitome's commit boundary.

Do not copy every configuration mode. Pi core defaults to parallel Tool execution and can force a batch sequential when a called Tool requires it (`C/src/agent.ts:250`; `agent-loop.ts:499–535`). Mitome's selected serial execution is simpler and remains unchanged. Native Effect functions, Tools, Schemas and Layers replace Promise callbacks and mandatory wrappers, rather than reproducing Pi's public Agent class or Extension framework.

## Reuse: history ancestry and Compaction as projection

Ordinary SessionManager appends entries with `id` and `parentId`; changing the selected leaf creates an alternate continuation without deleting old history. Context building projects the selected ancestry and applicable Compaction. The original entries remain. See `I/dist/core/session-manager.js:232–300,827–837,1087–1100,1151–1194`.

Tree navigation refuses while streaming or compacting. Selecting a user Message moves before it and restores its text for editing; other valid selections continue after the chosen entry. Branch summaries explicitly carry abandoned-path information. See `I/dist/core/agent-session.js:2855–2865,2965–3010`.

These are strong references for Mitome's tree-owning Transcript, selected Branch projection, compatible Checkpoints and idle-only execution-Branch switching. Concrete IDs, persisted selection and structural Tool boundaries still need Mitome contracts; copying an entire SessionManager is not necessary.

### Important deliberate difference: what is committed

Ordinary AgentSession persists finalized `message_end` objects, including an assistant message ending aborted/error/length. Completed messages can therefore survive a later failure; it does **not** wait for whole-program success before keeping all conversation. Public event dispatch occurs before its persistence hook (`I/dist/core/agent-session.js:556–610`).

Mitome instead selected whole-program conversational commit, with completed-Step progress and Tool intent/outcomes retained separately as Execution state. That is a real behavioral difference, not an incidental API spelling. It adds staging/recovery work and means partial work must remain inspectable without being presented as committed conversation. If closer ordinary-Pi behavior is desired, this policy needs explicit owner reconsideration; the reference review does not silently change it.

## Adapt: explicit recovery, not arbitrary code replay

The installed **0.87.1 Harness**, unlike ordinary conversation restoration, has durable operation mechanics. In this section, `runtime/…` paths are relative to `C/src/harness`:

- A logical Tool invocation has a stable identity across safe replay; its invocation capability checks that it still owns the pending effect. See `C/src/harness/types.ts:95–105` and `runtime/drive/tools.ts:82–129`.
- It commits Tool intent and prepared arguments before invoking the effect, then stores an outcome before materializing it. See `runtime/drive/tools.ts:187–293,475–513`.
- It retries an interrupted pending Tool only when both the recorded intent and current Tool definition declare replay safe. Otherwise it records an interrupted outcome explicitly stating that the external outcome is unknown. See `runtime/drive/tools.ts:516–540`.
- That interrupted outcome has `terminate: false`; sequential batch processing can continue. See `runtime/drive/tools.ts:44–45,158–167,542–608`.

Borrow stable invocation identity, intent-before-effect, recorded outcomes and explicit replay classification. Two replay-safe declarations alone do not prove changed-code/schema compatibility or upstream idempotency. Do **not** interpret them as serialization of arbitrary JavaScript/Effect continuations.

Mitome's unresolved-outcome fence is intentionally stricter than this inspected Harness policy. Its explicit outcome lookup and guarded abandonment are separate choices. Automatically feeding an unknown effect back as an ordinary Tool error and continuing would change the approved policy and requires owner confirmation. Pi provides a concrete alternative, not proof that either behavior suits every application.

Ordinary coding-agent resume only restores conversation/configuration through a supplied SessionManager: `I/dist/core/sdk.js:67–123`, `session-manager.js:1326–1366`. It is not the Harness recovery path.

## Adapt: one hosted owner, multiple presentations

The **v0.85.1 experimental server** already demonstrates multiple presentation attachments to one hosted Session. Its router reuses an existing or pending Session acquisition, checks attachment identity, tracks admitted service calls and waits for them before releasing an attachment (`O/packages/server/src/session-router.ts:200–292`). The README explicitly separates presentation demand from worker/Harness lifetime (`O/packages/server/README.md:3–16,71–79`).

This is useful precedent for Mitome's explicitly connected TUIs and shared owner. It is not a reason to import Pi's worker system, facet services, Chord, CBOR protocol or coordinator. Reuse Mitome's selected authenticated HTTP boundary and native application Scope unless a concrete requirement demands more machinery.

Qualifications:

- Stale attachment routing is not proof of Mitome's expected Branch/history-position checks.
- The server aborts outstanding **request** controllers when a client disconnects, while attachment release waits for admitted calls (`O/packages/server/src/server.ts:418–438`). Whether accepted Agent work survives depends on its service/owner wiring, not the router alone.
- Peer authentication is explicitly application policy, not supplied by that experimental Unix transport (`server/README.md:77`). Mitome must retain its authentication and ownership checks.
- Ordinary coding-agent RPC is a long-lived subprocess protocol, not this shared server. Closing stdin requests shutdown; a prompt response is not completed work (`I/docs/rpc.md:1–18,35–69,89–93`).

## Do not copy: observer or storage guarantees by analogy

### Observer seams differ

Core `Agent` reduces state and **awaits** its listeners (`C/src/agent.ts:554–608`). Ordinary coding-agent `AgentSession` invokes public listeners synchronously without awaiting returned promises, while awaiting its Extension dispatch before persistence (`I/dist/core/agent-session.js:497–501,579–596`). Neither path proves bounded, isolated, passive progress delivery. Keep Mitome's authoritative controls/commit path separate from its lossy observation path.

### Persistence format is not a failure guarantee

Ordinary SessionManager updates memory before `_persist()`, defers initial file creation until an assistant Message exists, and uses synchronous file writes without an explicit flush protocol in these paths (`I/dist/core/session-manager.js:754–817`). This does not establish Mitome's acknowledged power-loss guarantee.

The separate Harness JSONL implementation queues commits, replays complete transactions, rejects malformed complete records and repairs a torn tail. Its append path updates validated memory after the append (`C/src/harness/session/jsonl/storage.ts:85–153`). These are useful narrow mechanisms, not proof of synchronized storage, cross-process exclusion or exactly-once external effects.

The older SQLite backend configures WAL and explicit transactions (`O/packages/session-backends/sqlite-node/src/sqlite/repo.ts:64–69`, `src/index.ts:78–95`), but explicitly delegates cross-process writable ownership to the host (`README.md:31`). Its documented local checks are not a cross-process lease/fence. No inspected storage path or static test establishes Mitome's full Node/Bun/platform/machine-crash contract. SQLite remains a candidate, not a selected or verified backend.

## Recommended design discipline

1. **Use reference-backed defaults rather than questionnaire-driven mechanics.** Derive straightforward ordering, ancestry, validation and lifecycle details from inspected sources and native Effect primitives; reserve user questions for genuine product trade-offs.
2. **Keep the public surface small.** Ordinary Agent functions, a scoped Session/Turn boundary, controlled generation/Tool operations and a default loop. Do not add Pi-shaped classes or a generic callback registry to appear conventional.
3. **Keep durable machinery behind that surface.** History, execution and delivery are distinct responsibilities, not mandatory separate databases, packages or generic event-sourcing frameworks.
4. **Use the existing Host seam.** One application owner, explicit HTTP-backed attachment and shared execution, without automatic daemon discovery or a new service-routing framework.
5. **Make each departure earn its cost.** Whole-program atomic conversation, stronger uncertainty fencing, power-loss acknowledgement, durable deduplication/results and passive observers come from Mitome requirements—not automatically from ordinary Pi behavior. Preserve them unless the owner changes the requirements; test them separately.

The strongest conclusions are conventional boundary choices supported by real implementations, not a certification that every planned protocol is standard. Exact public signatures and native Effect integration still need their own source-backed proofs.

## Research corrections and limits

The raw investigations and review are retained under workflow `0aa965a4-ddd6-43c6-a4b5-a5407446f83b`; this synthesis corrects them:

- The older checkout **is present**. Its initial absence claim is rejected; the parent read its server/backend source and verified the pin.
- `continueSession` is **not** a current `CreateAgentSessionOptions` field. It appears in stale JSDoc, while the actual declaration accepts `sessionManager` (`I/dist/core/sdk.d.ts:10–56,87–90`). Do not copy that example.
- Observer behavior is qualified by layer, not generalized to all Pi subscribers.
- The parent also verified the Tool replay/unknown-outcome policy in installed **0.87.1** source; this conclusion need not rely only on the older checkout.

No production implementation, dependency upgrade, Pi patch, installation or upstream publication was performed. Source inspection does not settle runtime correctness or the outstanding storage integration blocker. Approved decisions remain unchanged by this report.
