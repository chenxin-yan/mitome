# Acquire Resources with a setup-scoped `defer`

The Promise SDK acquires an Extension Resource through one field, `resource: async ({ defer }) => Resource`, replacing the `setup` and `dispose` pair. `defer(cleanup)` registers a cleanup for the step that just succeeded; the registered cleanups run in reverse registration order when the Session is released, on success, failure, and interruption alike. Across Extensions nothing changes: the Session Scope still releases Resources in reverse Agent Definition order, after `sessionEnd` Hooks (ADR-0049).

The pair leaked on partial failure. With `dispose(resource)` the cleanup receives the value `setup` returned, so when `setup` opened a database and then failed to connect a bus, `dispose` never ran and the database stayed open. Registering cleanup as each step succeeds is the shape every disposal API converged on: TC39 `DisposableStack.defer`, Effect's `addFinalizer`, Go's `defer`, Python's `ExitStack.callback`. The implementation is `Effect.addFinalizer` registered on the Layer's Scope before the Promise runs, closing over a callback list; there is no hand-rolled stack and no `Scope` in the public signature.

Cleanup errors keep their existing semantics. On a failed exit they are logged so the primary tagged error survives; on a successful exit the remaining cleanups still run and the first error is then rethrown. A `defer` called after acquisition settled needs no guard: while the Session is live the callback joins the same list and runs at release, and release drains that list rather than snapshotting it, so a cleanup that defers more work is honoured too. Only a `defer` after release has completed is dropped, which is the same post-release misuse the next sentence covers, so no crust-style throw is warranted. A guard against reading `resource` after release is unreachable, because Hooks and handlers only run inside the Session and `isReleased` already blocks Turns.

The field is named `resource` so one glossary term spans Core's `resource: Layer`, the SDK field, and `context.resource` in Hooks and handlers. The change is breaking and ships without a compatibility shim, as pre-release allows. Test doubles need no API: `defineExtension({ ...definition, resource: async () => fake })` replaces the Resource by spread.

This amends ADR-0032, which described the SDK's `setup` composing a Resource by returning a record; `resource` composes the same way. ADR-0043's scoped builder is unaffected, since it binds the Resource type, not the field that produces it.

## Consequences

- `setup` and `dispose` are gone from `@mitome/sdk`, its tests, and the documentation; the `dispose` without `setup` definition-time error goes with them. Hooks and Tools that use a Resource still require `resource`.
- `resource` is contextually typed: declared after `tools` or `hooks` with unannotated callbacks, TypeScript fixes the Resource to `never` before it reads the return type. Examples declare `resource` first; the exported `ResourceContext` type annotates the parameter when another order is wanted.
- `Symbol.asyncDispose` on the returned Resource and an `AbortSignal` for acquisition remain out of scope until a real Resource needs them.
