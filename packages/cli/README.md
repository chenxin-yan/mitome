# @mitome/cli

The `mitome` command. The compiled binary embeds Bun and loads one Configuration: a module whose default export is `Mitome.make(...)` from `@mitome/core`. Without `--config` it loads `index.ts` in the config directory (`$MITOME_HOME`, else `$XDG_CONFIG_HOME/mitome`, by default `~/.config/mitome`); `--config` selects a directory (its `index.ts`) or a file instead. It never searches the current directory.

```text
mitome run [--config <path>] [--provider <id>] [--model <provider/model>] [--grace <duration>] [input]
mitome providers [--config <path>]
mitome auth status|login|logout [--config <path>] [--provider <id>]
```

`run` is one-shot: it reads one input (the argument, else all of non-terminal stdin), runs one Turn and writes only the rendered result to stdout. Nobody is present to answer an Approval, so a Tool Call that needs one is denied, the Model is told, and the Turn continues. Logins are stored in the state directory (`$MITOME_HOME`, else `$XDG_STATE_HOME/mitome`, by default `~/.local/state/mitome`) and shared by every Configuration. On Windows the defaults are `%APPDATA%\mitome` for the config directory and `%LOCALAPPDATA%\mitome` for the state directory. See the [CLI guide](https://mitome.sh/docs/cli).
