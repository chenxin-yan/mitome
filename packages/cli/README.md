# @mitome/cli

The `mitome` command. The compiled binary embeds Bun and loads one Configuration: a module whose default export is `Mitome.make(...)` from `@mitome/core`. Without `--config` it loads `index.ts` in the config directory (`$MITOME_HOME`, else `$XDG_CONFIG_HOME/mitome`, by default `~/.config/mitome`); `--config` selects a directory (its `index.ts`) or a file instead. It never searches the current directory.

`mitome init` writes the default Configuration into the config directory: `agent.ts` (an Agent with a `dice` Extension whose `roll` Tool needs Approval), `index.ts`, `package.json`, `tsconfig.json`, `.gitignore` and a README. It asks for the Provider (`openai`, `openai-codex` or `anthropic`) and one of its Models on a terminal, or takes `--provider` and `--model`, and refuses a config directory that is not empty. It then installs the dependencies there with itself as Bun's installer (`BUN_BE_BUN=1 mitome install`), unless `--no-install` is given; if that fails, the files stay and it prints the command to run.

```text
mitome init [--provider <id>] [--model <id>] [--no-install]
mitome [--config <path>] [--provider <id>] [--model <provider/model>] [--grace <duration>] [--continue[=<id>]]
mitome run [--config <path>] [--provider <id>] [--model <provider/model>] [--grace <duration>] [--continue[=<id>]] [input]
mitome providers [--config <path>]
mitome auth status|login|logout [--config <path>] [--provider <id>]
```

Bare `mitome` opens the terminal: it needs a terminal on stdin and stdout, keeps one Session, runs each submission as one Turn and answers Approvals there, showing the Tool Call with its parameters as the JSON the Model sent and waiting for `y` (allow) or `n` (deny). `run` is one-shot: it reads one input (the argument, else all of non-terminal stdin), runs one Turn and writes only the rendered result to stdout. It provides no Approver, so with the default program a Tool Call that needs Approval is denied, the Model is told, and the Turn continues. Each starts a new conversation for the working directory; `--continue` continues the one most recently written there and `--continue=<id>` the one with that id, when the Configuration keeps history with `@mitome/transcripts`. Codex logins are stored in the state directory (`$MITOME_HOME`, else `$XDG_STATE_HOME/mitome`, by default `~/.local/state/mitome`) and shared by every Configuration; the Anthropic sign-in lives in Anthropic's config directory, which `MITOME_HOME` does not change. On Windows the defaults are `%APPDATA%\mitome` for the config directory and `%LOCALAPPDATA%\mitome` for the state directory. See the [CLI guide](https://mitome.sh/docs/cli).
