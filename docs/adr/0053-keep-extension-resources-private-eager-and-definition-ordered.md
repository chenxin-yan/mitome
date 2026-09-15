# Keep Extension Resources private, eager, and Definition-ordered

Extension Resources stay as ADR-0041 left them: each Extension acquires its own Resource when `createSession` runs, in Agent Definition order, holds it for the Session, and releases it in reverse order when the Session Scope closes. No other Extension can see it. Mitome adds no named or lazy Context registry and no cross-Extension service mechanism.

The alternative evaluated was crust's `defineContext` (`packages/core/src/api/context.ts` in that repository). A crust Context is name-keyed (`"db"`), lazy (construction starts on the first `ctx.db` read), invocation-scoped, and shared by any command or Extension that `.use()`s it; `.provide()` scopes it positionally in the command tree with child shadowing, `.of(value)` substitutes a test double, and one `AsyncDisposableStack` per invocation holds returned disposables and `defer()` callbacks, settled before disposal so no in-flight construction registers on a closed stack. That shape fits a command tree: a CLI has many commands and one invocation, most Contexts are irrelevant to any given run, and laziness is what keeps an unused database from opening. A Mitome Session is a flat Extension array in which every Extension runs every Session, so laziness would buy nothing and would replace a fixed acquisition order with "whenever a Hook first touched it". Name-keyed identity would reintroduce the collision and shadowing rules that ADR-0042 removed by identifying Extensions by reference. The disposal stack already exists as the Effect Scope that owns the Session, with interruption handling crust hand-rolls.

The sharing question that a registry answers has no consumer. ADR-0035 built a Tag-keyed dependency graph and ADR-0041 (#117) removed it with no non-test consumer. The three realistic Extensions prototyped in #107 (project notes, shell guard, usage tracker) shared nothing. #106 found Vite, Fastify, pi, tRPC, and Hono share state by capturing it in a factory closure, not through a registry, and crust's own first-party packages do not use Contexts either; the pattern lives only in its docs and tests. When two Extensions do need one service, the answer is the same closure: construct the service at the composition root and pass it into each Extension factory (`notes({ db })`, `memory({ db })`). The application owns that service's lifetime; each Extension's `resource` stays private to it.

If a per-Session shared service ever has a real consumer, the additive path is Tag-based `provides`, still eager and still Definition-ordered. ADR-0035's probe already established that Effect Tag identity is the string key and survives duplicate package copies, so nothing about this decision forecloses it.

This reaffirms ADR-0041 and relies on ADR-0042 for identity, ADR-0049 for release order, and ADR-0035 for the Tag-identity evidence.

## Consequences

- Extension authors compose shared services at the composition root; documentation shows the factory-argument pattern and the spread-based test double rather than an API for either.
- The crust `defer()` shape is adopted for acquisition itself in ADR-0054; the registry it sits in is not.
