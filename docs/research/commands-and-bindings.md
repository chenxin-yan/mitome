# Commands and key bindings in other tools

Researched 2026-11-26 for the design of Mitome's commands: things a person invokes (slash commands, keys), as opposed to Tools the Model calls. Three lanes: agent harnesses, editors that separate actions from bindings, and chat platforms with multi-surface agent products. Primary sources only; anything not confirmed in one is marked UNVERIFIED.

## Findings

1. **Every tool separates the action from the binding.** The action is a named thing that can run; the binding is a slash name or a key that points at it. The action is a string id almost everywhere (VS Code `myExtension.sayHello`, Zed `editor::MoveUp`, opencode `acme.status`, pi `app.session.new`); Neovim alone uses function values, user commands or `<Plug>` mappings.
2. **Harnesses have two kinds of command.** Prompt-only (a Markdown or TOML file that expands to text for the Model) and code that runs. pi, opencode, Claude Code (plugin "mods") and Hermes let a plugin register code. Codex removed its prompt-only kind in 0.117.0 in favour of skills.
3. **Defaults are the main fork.** Neovim and Emacs say plugins should not bind keys ("Avoid creating excessive keymaps automatically", `:help lua-plugin`). VS Code, Zed, kitty and tmux ship a default layer the user overrides or switches off. No tool read ships no defaults and writes a starter set at install; the closest are kitty (writes its defaults commented into your config) and tmux (`list-keys` prints them as config lines).
4. **A slash name exists on every surface; a key exists only in a terminal.** Chat platforms deliver one free-text string after the name. Only Discord has typed options.
5. **Multi-surface products keep one registry and derive each surface from it.** Hermes derives CLI help, gateway dispatch, the Telegram menu and the Slack manifest from one `COMMAND_REGISTRY`, with `cli_only` and `gateway_only` flags for commands that make sense on one surface only.
6. **No editor hard-locks its own actions.** Quit, cancel and submit are ordinary, rebindable actions in VS Code, Zed, Helix and kitty. Harnesses reserve a few keys instead: pi protects 18 action ids from extension shortcuts, and Claude Code does not let Ctrl+C or Ctrl+D be rebound.

## Agent harnesses

| Tool         | Unit                                                                                                     | Who defines it                                                                                               | What the handler reaches                                                                                                             | Arguments                                             | Keys                                                                                                                                         | Conflicts                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| pi 1.6.0     | Command `{description, getArgumentCompletions, handler(args, ctx)}`; prompt template; skill              | Extension `pi.registerCommand(name, opts)`; user `prompts/*.md`; 23 built-ins                                | UI (select, confirm, editor text), session read, `newSession`, `fork`, `navigateTree`, `compact`; `pi.sendUserMessage` starts a Turn | One raw string; optional completion callback          | `keybindings.json`, `{ "action.id": key or [keys] or [] }`, built-in ids only; extensions call `registerShortcut(key, …)` with a literal key | Same name in two extensions becomes `/name:1`, `/name:2`; a clash with a built-in is hidden with a warning |
| Claude Code  | Skill (`SKILL.md`), legacy command file, built-in, plugin mod command                                    | Files at enterprise, user and project level; plugins (namespaced `/plugin:skill`); mods `$.command.register` | Prompt text; mods get `prompt.submit`, `model.complete`, `ui.*`                                                                      | `$ARGUMENTS`, `$N`, named; no schema                  | `keybindings.json` by context; `"meta+g": "command:compact"` binds a key to any command; `null` unbinds; Ctrl+C and Ctrl+D reserved          | Enterprise over personal over project; a mod registering a built-in name throws                            |
| Codex CLI    | Built-in only (closed enum in the TUI crate)                                                             | Core                                                                                                         | Fixed                                                                                                                                | Per command; Tab completes                            | `[tui.keymap.<context>.<action>]` in `config.toml`; `[]` unbinds                                                                             | UNVERIFIED                                                                                                 |
| opencode     | Command `{name, description, template or execute}`; TUI command `{id, title, bind, palette, slash, run}` | Markdown, JSON, server plugin, TUI plugin                                                                    | Session API; `delivery: "steer" or "queue"`; `context.ui`                                                                            | `$ARGUMENTS`, `$1`; no schema                         | `keybinds` in `cli.json`, `{ "id": "key" }`, `false` or `"none"` unbinds, `<leader>`                                                         | Later source replaces earlier; a custom command may replace a built-in                                     |
| Gemini CLI   | Custom command (`.toml`)                                                                                 | User, project, extension                                                                                     | Prompt only                                                                                                                          | `{{args}}`                                            | `keybindings.json`; `-command` unbinds                                                                                                       | Project over user over extension                                                                           |
| eve          | None in the Agent; slash commands are built into the `eve dev` Host                                      | Host                                                                                                         | Host                                                                                                                                 | Built-in                                              | Fixed table                                                                                                                                  | n/a                                                                                                        |
| Hermes Agent | `CommandDef` row in one registry; plugin command; `quick_commands`                                       | Core list; plugin `ctx.register_command(name, handler, description, args_hint)`; user YAML                   | Raw args, session id, `ctx.dispatch_tool`                                                                                            | Raw string; `args_hint`; `subcommands` for completion | UNVERIFIED                                                                                                                                   | A plugin name that clashes with a built-in is silently rejected                                            |

Details worth keeping:

- **pi gives commands a context no other code gets.** `newSession`, `fork`, `navigateTree` and `switchSession` exist only on the command context because they "can deadlock if called from event handlers". After one of them, the old context is stale and throws.
- **pi commands run headless.** `pi -p "/cmd"` reaches an extension command; `ctx.hasUI` is false and UI calls do nothing. Built-ins are interactive only.
- **Starting a Turn is an explicit call**: pi `sendUserMessage`, opencode `ctx.session.prompt`, Claude Code `$.prompt.submit`. pi does not re-parse injected text as a command unless asked.
- **Prompt files can hide code.** `` !`cmd` `` in Claude Code, Gemini and opencode runs before the Model sees the text; in opencode it runs "outside the agent's tool permission flow".
- **Busy behaviour is declared.** Hermes `busy_policy` is `dispatch`, `reject` or `interrupt_then_dispatch`; Codex has `available_during_task()`; Claude Code queues a command typed while it responds.

## Editors

| Tool                  | Action identity                                | Binding format                                                                                | Plugin defaults                                                                       | Remove a binding                                                       | Find actions                                                       |
| --------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Neovim with lazy.nvim | Lua function, `:UserCommand` or `<Plug>(Name)` | `vim.keymap.set(mode, lhs, rhs, { desc })`; lazy `keys = { { "<leader>ft", rhs, desc = … } }` | Norm is no; distributions (LazyVim) ship a separate layer loaded before the user's    | `{ lhs, false }` in a lazy spec; `:unmap`; `:mapclear` for none at all | `desc` feeds which-key                                             |
| VS Code               | String id, `ext.command`                       | `{ key, command, when, args }` in `keybindings.json`                                          | Yes, `contributes.keybindings`                                                        | `"command": "-id"`                                                     | Command Palette; shortcut editor lists every command, bound or not |
| Zed                   | String `ns::Action`                            | `[{ context, bindings: { "ctrl-a": "ns::Action" } }]`                                         | Core per-OS keymaps; `base_keymap: None` disables all                                 | `null`                                                                 | Command palette; keymap editor                                     |
| Helix                 | Command name                                   | `[keys.normal]` in `config.toml`                                                              | Core only                                                                             | `no_op`                                                                | Info box under a prefix                                            |
| Emacs                 | Symbol of an interactive function              | `(keymap-set map "C-c o" #'cmd)`                                                              | Convention: loading a package must not change behaviour; `C-c <letter>` is the user's | `keymap-unset`                                                         | `M-x`                                                              |
| tmux                  | Command with flags                             | `bind-key key command`                                                                        | Core                                                                                  | `unbind-key`                                                           | `list-keys -N`                                                     |
| kitty                 | Action name with arguments                     | `map ctrl+shift+c copy_to_clipboard`                                                          | Core, written commented into the user's config                                        | `no_op`; `clear_all_shortcuts yes`                                     | Command palette                                                    |

Details worth keeping:

- **Neovim's own guide argues against per-plugin binding options.** nvim-best-practices: "DON'T … define a fancy DSL for enabling keymaps via a `setup` function", because every plugin's differs and it errors when the plugin is absent.
- **lazy.nvim's `keys` fuses a binding with a load trigger.** That exists because Neovim loads plugin code from disk on demand; Neovim's guide says there is "no performance benefit" in users wiring it. Mitome needs only the binding.
- **The cost of no defaults is drift and a blank slate.** A new action stays unbound, and a binding can name an action that is gone. VS Code and Zed answer with a list of every action and what is bound to it; kitty and tmux with dumpable defaults.
- **Key notation.** `ctrl+x` (VS Code, kitty, pi, opencode, Claude Code) is the most widely shared. Helix's `-` separator forces `A-minus` for the minus key. Neovim accepts `<C-x>`, `<c-x>` and `<C-X>` and needs a formatter to tidy them.
- **Terminals cannot see every key.** Without the enhanced keyboard protocol, `ctrl+i` is Tab, `ctrl+m` is Enter and `shift+enter` is Enter. (The exact list was not verified from a primary source.)

## Chat platforms and headless use

| Platform | Declared as                                               | Arguments                            | Name and count limits                                          | Reply                                                                  |
| -------- | --------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Discord  | `name`, `description`, typed `options[]`                  | Typed options, choices, autocomplete | Name 1 to 32, lowercase; description 1 to 100; 100 commands    | Acknowledge in 3 s, then 15 min; private flag fixed at the first reply |
| Slack    | Manifest `slash_commands[]`                               | One free-text string                 | 32 characters including `/`; 50 per app; not usable in threads | 200 in 3 s; `response_url` allows 5 posts in 30 min                    |
| Telegram | `BotCommand { command, description }` via `setMyCommands` | Free text                            | `[a-z0-9_]`, 1 to 32; description 1 to 256; 100 per scope      | Ordinary messages; the menu is an advertisement, not a gate            |
| WhatsApp | `command_name`, `command_description`                     | Free text                            | 30 commands; name up to 32                                     | Ordinary messages                                                      |
| Matrix   | No registry in the released spec                          | The bot parses text                  | n/a                                                            | Ordinary messages                                                      |

What a Host-agnostic action must fit:

- **Name**: lowercase `[a-z0-9_]`, at most 31 characters (Telegram forbids hyphens and uppercase; Slack's 32 includes the slash).
- **Description**: one plain line, 1 to 100 characters (Discord is tightest).
- **Arguments**: one free-text string is the only form that works everywhere. A schema is an optional enhancement for Discord and for completion.
- **Reply**: text. Slow work must not assume a synchronous window; the Host acknowledges first.
- **Needing input**: products give every picker a typed twin. `/model` with no argument opens a picker; `/model sonnet` is the headless form (Claude Code, Codex, Hermes). Hermes routes confirmations to native buttons on Telegram, Discord and Slack, with a text fallback elsewhere, and answers by policy where nobody is present.
- **Surface-only commands**: Hermes marks `/redraw`, `/skin`, `/copy`, `/quit` as `cli_only`. `/clear` ("clear screen and start a new session") mixes a surface effect with a conversation effect; the portable form is `/new`.
- **Headless**: Claude Code runs user commands in `claude -p "/name"`, says `"/theme isn't available in this environment."` for terminal-only ones, and since v2.1.274 sends an unknown `/name` to the Model as text.

## Do commands exist outside the terminal, and where does the list live?

| Tool         | Outside the terminal                                                                                                                                                                                                                    | Where the command list lives                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| opencode     | Yes. Its HTTP API has `GET /api/command` ("Retrieve currently registered commands", each with `name` and `description`) and `POST /api/session/{sessionID}/command` ("Run a named command in the session. Most commands send a prompt") | In the server: config, Markdown files and server plugins. Terminal-only commands are separate and come from TUI plugins |
| Claude Code  | Yes. `claude -p "/name"` runs one, and the SDK's first message lists `slash_commands`                                                                                                                                                   | In the engine. Terminal-only built-ins such as `/theme` are left out of that list                                       |
| pi           | Yes. Extension commands run in print and RPC mode; RPC has `get_commands`                                                                                                                                                               | In the session engine. Built-ins are interactive only                                                                   |
| Hermes Agent | Yes. Telegram, Discord, Slack and others                                                                                                                                                                                                | One registry below every surface, with `cli_only` and `gateway_only` flags                                              |
| Codex CLI    | No                                                                                                                                                                                                                                      | A closed enum in the terminal UI's crate                                                                                |
| eve          | No, apart from a chat platform's own                                                                                                                                                                                                    | Built into the `eve dev` terminal                                                                                       |

Every tool with more than one surface keeps its portable commands below the user interface and keeps terminal-only ones apart. None defines its portable commands inside the terminal's own settings.

## Alchemy: declaring by yielding

Alchemy 2 (<https://alchemy.run>) is infrastructure as code written in Effect. It is not an agent tool, but its extension model bears on how an Extension reaches a Host's abilities.

- **A declaration is a value, and yielding it only registers it.** "A resource declaration like `Cloudflare.R2.Bucket("Bucket")` is just an `Effect` — calling it doesn't talk to the cloud. `yield*`-ing it inside a Stack doesn't either; it just registers the resource on the stack and hands you back a typed `Output` reference." The work happens later, when the collected graph is planned and applied.
- **Declarations are exported and referenced by value.** "Because the declaration is just a value, you can `export` it and import it from anywhere." Yielding the same one from two modules registers it once, because resources are keyed by name.
- **A feature is one unit that owns what it needs.** "In Alchemy, a Layer owns its infrastructure and service implementation so that features can be decomposed."
- **Requirements live in types.** "Each Layer declares what it needs in its type: the resources it creates, the access it grants, and the services it calls. Leave one out and the program doesn't compile."

Reading: registering through an API inside an Effect can stay declarative when registration only collects descriptions and runs nothing. The costs ADR-0058 measured for "an Extension is a Layer that registers what it adds" came from doing the work while registering (opening connections, building Layers concurrently), not from yielding as such.

## Mistakes other tools made

- A plugin's command silently dropped on a name clash (Hermes), or hidden with only a warning (pi).
- The command set living in the UI package, so no other surface can reuse it (Codex).
- Six shapes for one key binding value (opencode: string, comma list, array, object, `false`, `"none"`).
- An unbind value that also blocks lower layers (Zed's `null`).
- Removing the prompt-file kind without a migration (Codex 0.117.0, issue #15941).
- A generated registration that drifts: Hermes documents re-pasting the Slack manifest by hand after updates.

## Not verified

- Codex: any plugin command API; how `codex exec` treats a leading `/`.
- opencode: slash text in `opencode run`; whether `keybinds` can rebind a plugin's command id.
- pi: the dispatch order between a built-in and an extension command of the same name (only the autocomplete filter was read).
- Hermes: key bindings; slash text in `hermes -z`.
- Which key combinations a terminal cannot distinguish, from a primary source.

## Sources

- pi 1.6.0 installed docs (`extensions.md`, `keybindings.md`, `prompt-templates.md`, `skills.md`, `rpc.md`) and `pi-mono` source (`core/extensions/types.ts`, `core/extensions/runner.ts`, `core/agent-session.ts`, `core/slash-commands.ts`).
- Claude Code: <https://code.claude.com/docs/en/skills>, `/commands`, `/keybindings`, `/headless`, `/plugins/mods/api`, `/agent-sdk/slash-commands`.
- Codex: <https://developers.openai.com/codex/cli/slash-commands>, <https://github.com/openai/codex/issues/15941>, `codex-rs/tui/src/slash_command.rs` at `af719423`.
- opencode: <https://opencode.ai/docs/commands/>, `/keybinds/`, `/build/plugins/cli`, `/build/plugins/server`, `/server/` (the HTTP API).
- Gemini CLI: `docs/cli/custom-commands.md` in google-gemini/gemini-cli.
- eve: local source `docs/extensions.md`, `docs/guides/dev-tui.md`.
- Hermes Agent: `hermes_cli/commands.py` and `commands_platforms.py` at `30db18aa`; <https://hermes-agent.nousresearch.com/docs/reference/slash-commands>.
- Neovim: `runtime/doc/lua-plugin.txt`; <https://lazy.folke.io/spec>; <https://github.com/nvim-neorocks/nvim-best-practices>; <https://www.lazyvim.org/configuration/plugins>; <https://github.com/folke/which-key.nvim>.
- VS Code, Zed, Helix, Emacs, tmux and kitty: their official keybinding documentation.
- Alchemy: <https://alchemy.run>, `/concepts/resource/`.
- Discord, Slack, Telegram and WhatsApp: their official developer documentation; Matrix MSC4332.
