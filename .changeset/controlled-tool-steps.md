---
"@mitome/core": minor
"@mitome/providers": minor
---

Add controlled Steps inside native Turns.

- `step` runs one generation with native Tool resolution disabled. It validates the whole response before any local handler runs and returns either a complete result (the original native response plus separately resolved local Tool results) or an `Incomplete` value that dispatched and staged nothing.
- `loop` repeats the same Step and fails with `IncompleteStepError` on incomplete output.
- Steps of one Turn are admitted one at a time; a Step started from its own callbacks is rejected as a defect instead of waiting forever.
- `step` and `loop` require the Tools' parameter-encoding services as well as their handler services, and a synchronous throw from `policy`, `consent` or `authority` denies the call.
- `localTools` registers native Tools and handlers once. Each call is decided once by `policy` or the Tool's own risk flag, needs exact-argument `consent` when asked, is rechecked by an optional current `authority` and runs serially.
- Malformed or unsupported responses fail with `StepProtocolError`. Native approval parts in the Prompt are rejected before generation.
- `makeSession` now requires `limits`; pass `firstPartyExecutionLimits` for 64 generations and 256 local dispatches per Turn.
- A Step requires `ModelRequestAccounting` for the exact Model in use; `withModelRequestAccounting` and `providerModel` build it.
- `toolOutcomes(tools)` reads the local Tool results this Turn's Steps recorded through `tools`, including earlier results of a Step that failed at a later call; it works while the Session lives, even after the Turn ends, and fails with `SessionReleasedError` after release. `Turn.usage` follows the same rule. A Turn handle that escapes its Turn can no longer start generations or dispatch Tools.
- Staged conversation carries a native `Schema.Void` Tool result as JSON `null`; returned results keep their native values.
- `makeProvider` and `providerModel` keep the provisioning Layer's error and requirements in their types (`Provider<Id, ModelIds, E, R>`), and `withModelRequestAccounting` keeps the binding Layer's other services. `AnyProvider` covers Providers with any provisioning requirements; only a Provider's own static type shows that it needs nothing further.
- The first-party Providers report every physical Model request, and their Model requests no longer follow HTTP redirects (native `redirect: "error"`, kept over a caller `RequestInit`); credential and token requests are unchanged. Codex's `generateText` now keeps reasoning, metadata and the finish part. Codex treats a `response.incomplete` without a reason, or a completed/done event whose response status is `incomplete`, as incomplete, and fails a completed/done event whose status is failed, cancelled (with the provider's message when present), non-terminal or invalid.
- Codex fails a complete response before any dispatch when a Tool call, message or reasoning item is unfinished, a call starts without `call_id` or completes without JSON arguments (no longer read as `{}`), a call's completion contradicts its start, a non-empty terminal `response.output` differs from the streamed items, an output item's lifecycle or locators conflict, output arrives after the terminal event, or any Provider-executed, approval or other unrepresentable output item appears; a message sent whole in its done event keeps its text, a refusal is kept as an empty text part with `metadata.openai.refusal`, and a later Codex request whose conversation contains a refusal fails before sending, and honours `toolChoice` `auto`, `none` and `oneOf` (auto mode), rejecting other choices before sending.
- The Definition-driven step runner, Tool execution pipeline and Model resolver are removed.
