# Parse-don't-validate refactor plan

Replace core's first-failure `validateAgentDefinition` with an aggregating
`compileAgentDefinition` returning `CompiledAgent`, thread the compiled result through
session/toolkit/approval, and move every serialized-input boundary (CLI + providers) to
Effect Schema decode — deleting all superseded validation code, no shims.

Executor note: before writing any Effect Schema code, run
`effect-solutions show data-modeling error-handling testing` — effect@4.0.0-beta.102 APIs
(`Schema.TaggedErrorClass`, `Schema.decodeUnknownEffect`, `Schema.fromJsonString`,
`decodeUnknownSync`/`decodeUnknownResult`) differ from v3.

## Decisions (locked)

- **D1 — AgentDefinitionError shape**: `Schema.TaggedErrorClass` with field
  `issues: Schema.NonEmptyArray(Schema.String)`; class body adds `get message()` returning
  `this.issues.join("\n")`. Verified on beta.102: the base `ErrorClass` sets no own
  `message` property when none is passed, so the subclass getter is reached; yieldable;
  no TS2611. Renderers (`host.ts` `_tag: message`, `support.ts` `.message`) print all
  issues with zero changes. Issue strings keep today's exact wording.
  Executor detail: single construction site guards `issues.length > 0` and narrows the
  collected `Array<string>` to the nonempty type.
- **D2 — Issue ordering** (deterministic, asserted in tests):
  (0) retired `instructions` key, (1) per-element provider structural issues + duplicate
  provider ids in array order, (2) malformed model / unregistered provider id, (3) plugin
  traversal in definition order — per plugin: structural issues, duplicate plugin name,
  duplicate tool names, orphan input validators, orphan result validators, duplicate
  handler names, (4) missing handlers, (5) orphan handlers.
- **D3 — Compiler input**: `compileAgentDefinition(definition: AgentDefinition):
Effect<CompiledAgent, AgentDefinitionError>`; the implementation defensively handles
  malformed structure as aggregated issues. Named threat: the CLI child host imports an
  arbitrary user module's default export — the one untrusted caller. Structural checks
  MUST be per-element, not just top-level (review blocker B1):
  - top level: non-object definition, `providers`/`plugins` not arrays, `model` not a string
  - per provider: non-null object with string `id`
  - per plugin: non-null object with string `name`, `instructions` is `undefined | string`
    This subsumes and lets us delete `cli/src/hosts/host.ts` `isAgentDefinition` without
    regressing `cli.test.ts:672-688` (plugin with non-string `instructions` must still exit 1).
- **D4 — Per-turn model override**: no compiled resolver exported. `session.ts` keeps a
  session-local `resolveModel`; the default path consumes pre-parsed `compiled.defaultModel`
  (no reparse); the override path still calls `parseQualifiedModelId` + `compiled.providers`
  lookup and fails with `TurnError` as today. Cache key stays the qualified-id string;
  `definition.model` string is the default cache key.
- **D5 — SDK definition-time throws** (`packages/sdk/src/plugin.ts`):
  - `standardInput`/`standardOutput` schema-shape checks (:79-83, :94): stay as synchronous
    `definePlugin`-time throws (typed construction validating a foreign Standard Schema
    implementation), but become plain `new Error(...)` instead of `AgentDefinitionError`.
  - dispose-without-setup (:238-241): stays in SDK as a plain `Error` throw.
  - per-plugin duplicate tool names (:247-249): deleted — core's compiler detects and
    aggregates duplicates, including cross-plugin.
  - Runtime Standard Schema `validate` paths (:99-116, :296-310, :354-365) untouched —
    runtime data-boundary parsing, not definition validation.
- **D6 — SSE decode strictness** (`providers/openai-codex/sse.ts`): per-event-type Schema
  structs decoded with a sync/Result decode variant inside the existing `decodeEvent`;
  unknown `type` values remain silently ignored (forward compat) — and unknown
  `output_item.added/done` item `type` variants likewise decode to `[]`, matching today's
  tolerance (sse.ts:69, 120-123). Decode failures map to the existing exact
  `invalidOutput`/`providerError` messages. Stateful call/text bookkeeping and
  `Tool.unsafeSecureJsonParse` for tool arguments stay imperative/as-is.
- **D7 — Catalog tolerance** (`cli/src/catalog.ts`): cache file gets a strict Schema
  (`fromJsonString`; failure → `undefined` = ordinary miss). Accepted narrowing: today a
  partially-valid cache is filtered and used (catalog.ts:42-48); under strict decode one
  bad entry makes the whole cache a miss — the fallback path (miss → refetch →
  stale/static) is preserved, so "tolerance narrowed, fallback preserved". models.dev API
  payload gets an envelope Schema plus per-model decode where non-conforming models are
  filtered out, not fatal.
- **D8 — Out of scope / left as-is** (each is a live-object or line-editing boundary,
  not serialized-unknown decode):
  - `plugins/src/instruction-files.ts` + `instructions.ts`: sync fs `Error` throws stay
    (developer-authored path resolution at typed plugin construction, consistent with D5).
  - `cli/src/config.ts` `.env` regex/character guards: line-preserving editor by design.
  - `cli/src/hosts/auth-host.ts` provider extraction: live imported object graph.
  - `cli/src/args.ts`: already Effect CLI schemas at the boundary; no change.
  - `providers/shared/oauth.ts` callback/pasted URL parsing (`new URL`,
    `validateAuthorization`): URL parsing, not JSON decode.
  - `providers/shared/api-key-client.ts`: env via Effect `Config` stays.
  - `packages/create-mitome`: typed interactive input only.
  - Provider factories (`openai`, `openai-compatible`, `openai-codex` index files):
    already typed construction.
  - Dev scripts `scripts/generate-model-hints.ts:28`, `scripts/dev-cli.ts:18`
    (`JSON.parse(...) as` casts): intentionally exempt, dev tooling.

## Phase 1 — Core compiler (blocks everything)

1. **Rewrite `packages/core/src/agent.ts`**
   - Delete `validateAgentDefinition`.
   - Change `AgentDefinitionError` per D1.
   - Add `export interface CompiledAgent`:
     - `plugins: ReadonlyArray<AnyPlugin>` (original refs, original order)
     - `providers: ReadonlyMap<string, AnyProvider>`
     - `defaultModel: { readonly providerId: string; readonly modelId: string }`
     - `tools: Readonly<Record<string, Tool.Any>>` (merged, name-keyed)
     - `toolOwners: ReadonlyMap<string, AnyPlugin>`
     - `handlers`: merged handler record (same erased type `toolkit.ts` uses today —
       keep the existing `as never` cast + comment rather than new type machinery)
     - `toolInputValidators` / `toolResultValidators`: merged records
     - `instructions: string` (joined `"\n\n"`, `""` when none)
   - Add `compileAgentDefinition` per D2/D3: single traversal collecting issues while
     building the compiled maps; fail with one `AgentDefinitionError({ issues })` when
     non-empty. Provider-provenance check (`getProviderMetadata(provider) === undefined`)
     stays `Effect.die` — a bug, not an issue.
   - No `Layer` building here — plugin resource contexts stay in session (effectful, scoped).
2. **Thread `CompiledAgent` through `packages/core/src/session/session.ts`**
   - `const compiled = yield* compileAgentDefinition(definition)`.
   - Delete local derivations now on `compiled` (providers map session.ts:59, instructions
     join :78-82); iterate `compiled.plugins` for resource-Layer building and hook phases.
   - `resolveModel` per D4. Error union tags unchanged; `createSession` signature unchanged.
3. **`packages/core/src/session/toolkit.ts`** — `makeToolkit(compiled, contexts)`; delete
   re-derivation of `baseTools`/`owners`/`validators`/merged handlers (:49-64); keep
   `Toolkit.make`/`toHandlers` wiring and runtime `validateResult`; postTool iteration
   uses `compiled.plugins`.
4. **`packages/core/src/session/approval.ts`** — `makeApprovals(compiled, contexts, base)`;
   delete local `inputValidators` merge (:87-90); iterate `compiled.plugins` for preTool.
5. **Exports + core tests**
   - `packages/core/src/index.ts`: keep `AgentDefinitionError`; add `compileAgentDefinition`
     and `export type { CompiledAgent }`.
   - Rewrite `packages/core/test/agent.test.ts`:
     - Exact-`message` assertions become `issues` assertions (same strings).
     - One multi-violation test asserting the full ordered `issues` array (D2).
     - Success test asserting `CompiledAgent` shape (providers map, parsed default model,
       merged tools/handlers/validators, joined instructions, plugin order).
     - Malformed-structure tests incl. per-element cases: `providers: [null]`,
       `plugins: [null]`, plugin with non-string `instructions` (B1).
   - Check `core/test/plugin/hooks.test.ts:257-293` (asserts TurnError, likely unaffected)
     and session tests constructing invalid definitions.
   - Gate: `cd packages/core && bun run check:types && bun run lint && bun run test`.

## Phase 2 — SDK + plugins (depends on Phase 1)

6. **`packages/sdk/src/plugin.ts`** per D5; drop the `AgentDefinitionError` import.
7. **SDK exports + tests**
   - `packages/sdk/src/index.ts`: keep `AgentDefinitionError` re-export; `effect.ts`
     wildcard surfaces `compileAgentDefinition`/`CompiledAgent` automatically.
   - `packages/sdk/test/tool-turn.test.ts:291-303`: duplicate-tool assertion moves from
     "definePlugin throws synchronously" to "createSession fails with AgentDefinitionError
     whose `issues` contains `Duplicate Tool name: echo`".
   - `sdk.test.ts` should pass unchanged; confirm.
8. **`packages/plugins`**: no source changes (D8). Confirm `plugins.test.ts` green.
   - Gate: per-package `check:types`, `lint`, `test` for sdk and plugins.

## Phase 3 — CLI (depends on Phase 1)

9. **`packages/cli/src/hosts/host.ts`** — delete `isAgentDefinition` and the
   "must default-export…" throw; pass the loaded default to `core.createSession`; the
   compiler reports aggregated structural + semantic issues (D3 covers per-element shape).
   Constraint: file is embedded as text (`child-host.ts:6-12`, `with { type: "text" }`)
   with type-only static imports — add no value imports. Verify multiline aggregated
   message renders acceptably via existing `_tag: message` formatting.
10. **`packages/cli/src/definition.ts:50-55`** — replace `JSON.parse(...) as` with
    `Schema.fromJsonString(Schema.Struct({ version: Schema.optional(Schema.Unknown) }))`
    decode to preserve today's behavior exactly: missing/non-string `version` still hits
    the version-mismatch message (review correction C1); malformed JSON → loud `Error`
    naming `packagePath`.
11. **`packages/cli/src/child-host.ts`** — replace `isProviderAuthentication` /
    `isCredentialDescriptor` guards with a Schema decoded from the file text via
    `fromJsonString`, passing `onExcessProperty: "error"` (verified available in beta.102)
    to keep exact-keys strictness; on ParseError keep the existing
    `"Agent Definition returned invalid Provider authentication metadata."` error.
12. **`packages/cli/src/catalog.ts`** — per D7. Keep `toolCapableOpenAiIds` export
    (scripts/generate-model-hints.ts imports it) and whole-catalog failure → fallback.
13. **CLI tests**
    - `cli/test/cli.test.ts:619-712`: invalid-definition tests assert aggregated
      AgentDefinitionError rendering (all issues visible); the `:672-688` non-string
      `instructions` case now fails via a compiler structural issue (B1) — keep exit-1
      assertion; delete assertions on the removed "must default-export" message; verify
      `:710-712` TurnError formatting unaffected; check `:1050-1065`, `:1206-1233` for
      incidental churn.
    - `cli/test/catalog.test.ts`: add malformed cache + malformed-model-entry cases
      proving tolerance semantics (D7, including the accepted cache narrowing).
    - `cli/test/command.test.ts:50-60` unaffected; confirm.
    - Gate: per-package `check:types`, `lint`, `test`.

## Phase 4 — Providers (independent; can run parallel to Phases 2–3)

14. **`packages/providers/src/shared/credential-store.ts`** — `readAuth`: replace
    `JSON.parse` + object checks with `Schema.fromJsonString(Schema.Record(Schema.String,
Schema.Unknown))` (verified: rejects array roots, preserving
    `credential-store.test.ts:179-181`); map ParseError to the exact existing
    corrupted-storage message incl. path (`test:166-181`); ENOENT → `{}` unchanged;
    `readCredential` still returns `unknown` (provider-specific decode downstream by design).
15. **`packages/providers/src/shared/oauth.ts`** — `exchangeToken`: Schema
    `Struct({ access_token: String, refresh_token: String, expires_in: Number })` decode;
    ParseError → existing `OAuthTokenError("OAuth token exchange returned an invalid
response.")`; keep non-2xx mapping and timeout.
16. **`packages/providers/src/openai-codex/credential-store.ts`** — `credentialFrom` via
    `OAuthCredential` Schema; failure → existing `CredentialUnavailableError` exact message
    (`oauth.test.ts:237-240`).
17. **`packages/providers/src/openai-codex/oauth-token.ts`** — claims Schema for the JWT
    payload. Lock current precedence (review correction C3): fall back to top-level
    `chatgpt_account_id` ONLY when the nested `https://api.openai.com/auth` claim is not
    an object; a nested object lacking the id errors — do not implement naive
    `nested ?? top-level`. Failure/empty id → existing
    `Error("OAuth access token did not contain an account.")`. `credential()` stays typed
    construction.
18. **`packages/providers/src/openai-codex/sse.ts`** — per D6.
19. **Provider tests** — all exact-message assertions pass unchanged (acceptance bar);
    add one malformed-shape case per new schema where none exists (e.g. token response
    missing `refresh_token`).
    - Gate: per-package `check:types`, `lint`, `test`.

## Phase 5 — Docs + consistency (last)

20. **ADR**: add `docs/adr/0033-parse-dont-validate-at-boundaries.md` (0033 verified next
    free number; follow existing ADR format): compile-not-validate for agent definitions
    with aggregated issues; Schema decode for serialized boundaries
    (files/JSON/HTTP/SSE/JWT/IPC); typed imperative construction for live object graphs;
    provenance violations die. `CONTEXT.md` has no validation-flow references (verified);
    update only if drift appears.
21. **Consistency checklist** (grep evidence for each):
    - [ ] `rg validateAgentDefinition` → zero hits (src, test, docs).
    - [ ] `rg "new AgentDefinitionError"` → only the core compiler construction site.
    - [ ] SDK `plugin.ts` no longer imports `AgentDefinitionError`.
    - [ ] No leftover `isAgentDefinition`, `isProviderAuthentication`,
          `isCredentialDescriptor`, manual `credentialFrom` checks, hand-written token-body
          checks.
    - [ ] `core/src/index.ts` exports `compileAgentDefinition` + `CompiledAgent`;
          `sdk/src/effect.ts` wildcard surfaces them.
    - [ ] D8 items untouched (incl. exempt dev scripts).
    - [ ] Intentional behaviors preserved: corrupted-storage message with path;
          silent-ignore unknown SSE event AND item types; catalog fallback-to-stale;
          provenance `Effect.die`; oauth-token claim precedence (C3).
22. **Final gates** (verified against root package.json):
    - `bun run check` (turbo lint + fmt check + typecheck)
    - `bun run test` (turbo vitest, all packages)
    - `bun run build:pkgs` (catches d.ts/export breakage)
    - Done only when all green; report exit statuses.

## Risks

- effect@4.0.0-beta.102 Schema API drift: verify each API against installed types /
  `effect-solutions` before writing; do not guess. (D1, `onExcessProperty: "error"`, and
  array-root rejection already verified by execution.)
- Exact-message tests in providers/cli: Schema ParseError defaults must be mapped, never
  leaked.
- Strictness regressions: catalog per-model tolerance (D7) and SSE unknown event/item
  tolerance (D6) are easy to tighten accidentally with naive union schemas — the added
  tolerance tests are the guard.
- `host.ts` embedded text: any new static value import breaks the embed; plan adds none.
