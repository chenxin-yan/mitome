# What Mitome can learn from eve and pi

Question: while redesigning Mitome's extension shape, Hosts, approvals, queued input and storage, what do eve and the pi coding agent do, and what is worth copying or avoiding?

Researched 2026-11-17 by two read-only scouts, one per codebase; the claims below were then re-read at the cited places. Nothing was run.

- **eve:** `vercel/eve` at tag `eve@0.54.3`, checked out in `.agent-sources/eve`. Paths below are relative to it.
- **pi:** installed 1.5.2 documentation. Paths are relative to the installed `pi-monorepo` directory. The older v0.85.1 source was not consulted.
- Related notes: `pi-extension-model.md` (pi's extension API and the owner's usage), `pi-reference-architecture.md` (pi's runtime layers), `one-shot-approval-behavior.md`.

## eve in brief

- "A filesystem-first framework for durable AI agents" (`README.md`). An agent is a directory of conventional slots: `instructions.md`, `agent.ts`, `tools/`, `skills/`, `channels/`, `schedules/`, `subagents/`, `hooks/`.
- Names come from paths: "The filename is the tool name the model sees" (`docs/tools/overview.mdx`). A discovery and compile step writes manifests under `.eve/` (`docs/reference/cli.md`).
- The loop runs as a durable workflow on Vercel's Workflow SDK; local state is under `.eve/.workflow-data` (`docs/concepts/execution-model-and-durability.mdx`).

## pi in brief

- "Pi is a minimal, extensible agent harness that you can make your own." It "ships with powerful defaults but skips features like sub-agents and plan mode" (`README.md:15-19`).
- One core, four surfaces: "All interfaces use the same agent and session mechanisms" (`docs/how-pi-works.md`). SDK and RPC are the same control model in-process and over JSONL (`docs/rpc.md`).
- An embedder can replace each boundary: model runtime, settings, session storage, resource loading, tools (`docs/sdk.md`).

## Extensions

|                      | eve                                                         | pi                                                 | Mitome (decided)         |
| -------------------- | ----------------------------------------------------------- | -------------------------------------------------- | ------------------------ |
| What an extension is | A package whose `extension/` tree mirrors the agent's slots | A function that registers things on an API object  | A plain data value       |
| How you use one      | A mount file: `export default crm({ apiKey })`              | `pi install npm:…`, then discovery                 | `use: [crm({ apiKey })]` |
| Name collisions      | The mount adds a prefix: `search` becomes `crm__search`     | A tool with a built-in's name replaces it silently | Not yet decided          |
| Hooks                | Observe only, after the event is recorded                   | 41 events; several mutate or gate, in load order   | Not yet designed         |

- eve packages "tools, channels, connections, skills, schedules, subagents, instruction fragments, and hooks" and takes consumer settings through `defineExtension({ config: z.object(...) })` (`docs/extensions.md`).
- eve limits what an extension may declare: "The extension root cannot declare agent configuration, instrumentation, memory, a sandbox, or nested extensions" (`docs/extensions.md`).
- eve scopes saved state to the extension: "`defineState` is automatically scoped to the extension package, so the same state name does not collide" (`docs/extensions.md`).
- eve's hooks subscribe to the runtime event stream and run "side effects after each event is durably recorded" (`docs/guides/hooks.md`). They are a data map: `defineHook({ events: { "session.started": handler } })`.
- pi warns extension authors about its hook model: handlers run "in extension load order, then registration order" and may mutate `tool_call.input` for later handlers (`docs/extensions.md`, Handler Composition); after a session is replaced, captured `pi` and `ctx` objects "are stale … and will throw if used" (`docs/extensions.md:1478`).

## Approvals and unattended runs

- eve puts approval on the Tool: `approval: always()`, `once()`, `never()`, or a policy function. `once()` asks "only the first time the tool runs in a session". "By default, omitted `approval` behaves like `never()`" (`docs/tools/human-in-the-loop.md:26-39`).
- eve can check who answered: a response policy receives the responder's `principalId` (`docs/tools/human-in-the-loop.md:74-94`).
- eve's scheduled "task mode" cannot wait for a person; it fails with "Task mode cannot wait for follow-up input" (`packages/eve/src/execution/turn-workflow.ts:48`). Read from code, not run.
- eve's HTTP routes fail closed: "production traffic is rejected unless you configure an authenticator that accepts it, and anonymous access requires an explicit `none()`" (`docs/guides/auth-and-route-protection.md:22`).
- pi has no approval step; a gate is an extension, and in print mode dialogs resolve at once (`one-shot-approval-behavior.md`).

## UI across surfaces

- pi carries extension dialogs over RPC as request and response records with an id: `select`, `confirm`, `input`, `editor`; plus fire-and-forget `notify`, `setStatus`, `setWidget` (`docs/rpc-extension-ui.md`).
- Everything terminal-specific degrades silently there: "`custom()` returns `undefined`", `setFooter()` and `setHeader()` do nothing (`docs/rpc-extension-ui.md`, Limitations).
- eve's channels render an approval request as buttons or a menu on each platform (`docs/tools/human-in-the-loop.md`).

## Queued input

- pi has two named points. `steer`: "delivered after the current assistant turn finishes executing its tool calls, before the next LLM call". `followUp`: "Delivered only when agent has no more tool calls or steering messages" (`docs/rpc-commands.md:48, 72`). A prompt is acknowledged as `started`, `queued` or `handled`; completion is a separate event (`docs/rpc.md`).
- eve defaults to `turnPolicy: "steer"`: it buffers the new message, cancels the active turn and starts a replacement; `"queue"` holds the message until the turn settles (`docs/concepts/execution-model-and-durability.mdx:111-113`).

## Durability and sessions

- eve's contract in two sentences: "Completed steps never re-run; eve replays the recorded result. A step interrupted mid-execution re-runs, so make non-idempotent side effects like charges or emails idempotent, or gate them with approval" (`docs/concepts/execution-model-and-durability.mdx:65`).
- fx's library makes this a per-Tool declaration: every Tool sets `idempotent`; a cut-off idempotent call runs again, a non-idempotent one never does on its own (https://fx.sh/docs/lib/tools.md, read 2026-10-31).
- pi stores a session as an append-only tree of entries with a current leaf. Compaction is an entry that keeps the raw history; an extension saves its own state as a `custom` entry outside the model's context (`docs/session-format.md`).
- pi's built-in file and shell tools take an `operations` object so the same tool can run locally, over SSH or in a container (`docs/extensions.md:2391`).

## Onboarding

- `npx eve@latest init my-agent` "creates a new `my-agent` directory, installs its dependencies, initializes Git, and starts the interactive terminal UI" (`README.md`).
- pi's directory discovery needs a trust decision, a `trust.json` and precedence rules between user, project and package locations (`docs/security.md`, `docs/settings.md`).
- eve ships its documentation inside the npm package "so coding agents can read it locally" (`README.md`).

## Lessons (judgement)

Copy:

1. A collision rule for names when extensions are merged. eve prefixes on mount; the alternative is to reject duplicates.
2. Observe-only events as a data map on the extension, kept apart from the few points that decide something (Tool policy).
3. A small UI vocabulary every Host can carry (ask, confirm, notify, status), so an extension's interaction works in a terminal, over HTTP and in a chat app.
4. `once()`-style approval, and checking who answered when a Host has identities.
5. Two named queue points with an acknowledgement that says what happened to the message.
6. State the recovery contract in two sentences. A per-Tool idempotency declaration is a much smaller design than reconciling every unknown outcome.
7. File and shell Tools built over a swappable operations service.
8. One command from nothing to a running terminal.

Avoid:

1. Mutating hook chains ordered by load order.
2. Directory discovery, which brings trust prompts, precedence tables and a compile step.
3. Unapproved by default.
4. Finding out mid-run that nobody can answer an approval.
