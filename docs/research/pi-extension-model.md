# How pi is extended, and what that means for Mitome

Question: Mitome should do what the pi coding agent does while being more flexible. What does pi actually offer, how is it extended, and which of those things would Mitome need?

Researched 2026-11-17 from the installed pi 1.5.2 documentation (`<pi>/docs/`, where `<pi>` is the installed `pi-monorepo` directory) and a scan of the owner's own pi setup in `~/.pi/agent`. Nothing here was run; the scan counts API call sites in installed package sources.

## What pi is

- **One loop, one process.** "A submitted message is added to the active branch. Pi builds a model request…, sends it through the selected provider…, executes each tool call, and records the results" (`docs/how-pi-works.md`, Agent loop).
- **Sessions are a tree in a JSONL file.** Each entry refers to its parent; continuing from an earlier entry makes a branch; Compaction inserts a summary entry and keeps the originals (`docs/how-pi-works.md`, Sessions).
- **Four interfaces over the same mechanisms:** interactive TUI, print mode, JSON mode, RPC mode, plus an in-process TypeScript SDK (`docs/how-pi-works.md`, Interfaces; `docs/sdk.md`).
- **Small built-in tool set.** "Default enabled tools are `read`, `bash`, `edit`, and `write`" (`docs/cli.md:130`). `codemode` is opt-in: the model writes a JavaScript script that calls the other tools in a QuickJS sandbox (`docs/codemode.md`).
- **No approval step.** "It does not ask for approval before every tool call" (`docs/security.md:3`); a permission gate is an extension.
- **MCP is built in** in this version: stdio or streamable HTTP servers, managed with `pi mcp add` (`docs/mcp.md`).
- **Skills** follow the Agent Skills specification: name and description are advertised, full instructions load on demand (`docs/skills.md`).

## How pi is extended

An extension is a TypeScript module whose factory receives an API object and registers things imperatively: "Their factory functions register tools, commands, shortcuts, providers, event handlers, renderers, and terminal UI" (`docs/how-pi-works.md`, Extensions and resources).

| Part of the API                                          | What it is for                                                                                                      | Where                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `pi.on(event, handler)`                                  | 41 documented events across startup, resources, session, agent, turn, message, tool, model, provider request, input | `docs/extensions.md`, Events               |
| `pi.registerTool`                                        | Add a Tool, including custom rendering and overriding a built-in                                                    | `docs/extensions.md`, Custom Tools         |
| `pi.registerCommand`, `registerShortcut`, `registerFlag` | Slash commands, key bindings, CLI flags                                                                             | `docs/extensions.md`, ExtensionAPI Methods |
| `ctx.ui.*`                                               | Dialogs, widgets, status line, footer, header, custom components, a custom editor                                   | `docs/extensions.md`, Custom UI            |
| `pi.sendMessage`, `sendUserMessage`                      | Put a message into the conversation, optionally starting a run                                                      | same                                       |
| `pi.appendEntry`                                         | Persist the extension's own state in the session                                                                    | `docs/extensions.md`, State Management     |
| `pi.registerProvider`, `registerMcpServer`               | Add a model provider or MCP server at runtime                                                                       | same                                       |

Events compose by rule, in extension load order: some only notify, some chain a transformed value (`context`, `tool_result`, `before_provider_request`), and some gate an operation (`tool_call` can block or change the input) (`docs/extensions.md`, Handler Composition).

Distribution is by **pi packages**: an npm or git package that bundles extensions, skills, prompt templates and themes, installed with `pi install npm:…` (`docs/packages.md`).

So pi's flexibility comes from hooks into a loop that pi owns. An extension cannot replace the loop; it reacts to it.

## What the owner's setup uses

Thirteen installed packages (`~/.pi/agent/settings.json`, `packages`). Counts are call sites in each package's source, excluding its `node_modules` and tests.

| Package                | Tools | Commands | UI calls | Events it listens to                                                                      |
| ---------------------- | ----- | -------- | -------- | ----------------------------------------------------------------------------------------- |
| pi-subagents           | 24    | 40       | 159      | session, agent, turn, `tool_result`, `context_with_system`, `input`, `before_agent_start` |
| pi-intercom            | 2     | 5        | 12       | session, agent, turn, tool execution                                                      |
| pi-web-access          | 9     | 8        | 34       | session, `before_agent_start`, `tool_call`                                                |
| pi-processes           | 1     | 7        | 37       | session, `tool_call`, compaction                                                          |
| pi-interactive-shell   | 2     | 3        | 30       | session                                                                                   |
| pi-hypa                | 9     | 1        | 2        | session, `before_agent_start`, `tool_call`                                                |
| pi-rewind              | 0     | 2        | 18       | session tree, turn, message, `input`                                                      |
| rpiv-ask-user-question | 1     | 0        | 14       | `before_agent_start`                                                                      |
| rpiv-todo              | 1     | 1        | 3        | session, compaction, tool execution                                                       |
| rpiv-btw               | 0     | 1        | 4        | session tree, compaction, `message_end`                                                   |
| pi-fast                | 0     | 2        | 10       | session, `model_select`, `before_provider_request`                                        |
| pi-usage-extension     | 0     | 1        | 2        | none                                                                                      |
| pi-wakatime            | 0     | 0        | 0        | turn, `tool_call`, `tool_result`                                                          |

What these packages do, most common first:

1. Add Tools (8 of 13).
2. Add slash commands (11 of 13) and draw terminal UI (12 of 13).
3. Start and stop a resource with the session (`session_start` or `session_shutdown`, 10 of 13).
4. Add to the system prompt (`before_agent_start`, 4 of 13).
5. Watch or gate Tool calls (`tool_call`, 4 of 13).
6. Put a message into the conversation (`sendMessage`, 4 of 13).
7. Persist their own state (`appendEntry`, 5 of 13).
8. Change the provider request (1 of 13).

The owner's default model is `anthropic/claude-opus-5-5`. Mitome has no Anthropic Provider at the stack tip (`packages/providers/src`: `openai`, `openai-compatible`, `openai-codex`).

## Mapping to Mitome

| What a pi extension does          | pi mechanism                         | Effect-native equivalent        | In the stack today                                    |
| --------------------------------- | ------------------------------------ | ------------------------------- | ----------------------------------------------------- |
| Add Tools                         | `registerTool`                       | A Toolkit plus a handlers Layer | Yes (`localTools`)                                    |
| Start and stop a resource         | `session_start` / `session_shutdown` | A Layer's acquire and release   | Yes (`infrastructure`)                                |
| Add to the system prompt          | `before_agent_start`                 | Instructions                    | Per-Step `instructions` option only                   |
| Gate a Tool call                  | `tool_call` handler                  | Policy, consent, authority      | Yes, but only as options the program passes to `loop` |
| Watch what happens                | notification events                  | An event stream                 | Turn outcomes only (`Session.observe`)                |
| Slash commands, terminal UI       | `registerCommand`, `ctx.ui`          | A Host concern                  | No                                                    |
| Put a message in the conversation | `sendMessage`                        | Follow-ups and steering (#171)  | No                                                    |
| Persist own state                 | `appendEntry`                        | The durable store (#170)        | No                                                    |
| Change the provider request       | `before_provider_request`            | Wrap the Provider's Layer       | Possible, no helper                                   |

Two differences in kind:

- pi lets an extension hook a loop it cannot replace. Mitome hands the loop to the author (`program`, `loop`, `step`), so a different control flow needs no hook.
- pi composes extensions through an event bus with ordering rules. The first four rows above need no bus in Effect: they are values (Toolkits, Layers, strings, policy functions) that can be merged.

What Effect composition alone does not cover is the Host side (commands, UI) and anything that needs durable state or queued messages.
