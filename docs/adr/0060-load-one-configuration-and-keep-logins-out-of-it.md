---
status: accepted
---

# Load one Configuration, and keep logins out of it

The `mitome` command loads one Configuration: `index.ts` in the config directory, or the directory or file given with `--config`. It never searches the current directory. Bare `mitome` opens the terminal with that Configuration and `mitome run` performs one Turn; there is no `tui` subcommand. ADR-0057 had required `--app <file>` on every command, so nothing could be opened by default.

This restores [ADR-0007](0007-load-the-default-definition-from-xdg-config.md) and [ADR-0027](0027-resolve-agent-definition-directories-through-index.md) for the native design, with the selector renamed from `--use`: the default lives in the config directory, a selected directory resolves only to its `index.ts`, and project-local TypeScript runs only when the user explicitly selects it.

A Configuration is something the author writes, keeps in Git and reuses on another machine. Three rules keep that true:

1. **Secrets by name, never by value.** A Configuration names the environment variable that holds a key.
2. **Paths resolve against the Configuration file**, so a Skills directory or instructions file inside the repository works anywhere.
3. **Nothing that changes behaviour is stored outside the Configuration.** A permanent permission rule is a line of policy, not a file the CLI wrote.

Credentials are therefore not in the config directory. They move from `<config-dir>/auth.json` to the state directory (`$XDG_STATE_HOME/mitome`, by default `~/.local/state/mitome`), and they are shared: selecting another Configuration does not ask for another login. `MITOME_HOME` still places Mitome's own config and state under one directory for tests and isolated setups. It does not hold every login: the Anthropic sign-in lives in Anthropic's config directory ([ADR-0063](0063-sign-in-to-anthropic-through-the-console-profile.md)). The file's mode, atomic rewrite and cross-process lock from [ADR-0010](0010-persist-provider-credentials-outside-the-environment.md) are unchanged.

For the same reason the `<config-dir>/.env` of [ADR-0013](0013-add-a-cli-credential-bootstrap-surface.md) is gone: the native CLI reads API keys from the process environment only and writes no key to disk. If a key bootstrap returns, it stores the key in the state directory.

Two tools create things, as [ADR-0023](0023-separate-project-and-default-agent-bootstrap.md) decided. `mitome init` writes the default Configuration into the config directory and installs its dependencies. `npm create mitome` scaffolds an application that uses Mitome as a library and embeds an Agent; it writes no Configuration. Apart from `init` the CLI only reads a Configuration: there is no `add`, `remove` or `install`. When installed dependencies do not match the lockfile, `mitome` installs what the lockfile declares and then runs, as [ADR-0037](0037-reconcile-selected-agent-definition-dependencies.md) decided, so a cloned Configuration works without a setup step.

## Considered options

- **`--config` moves the whole directory, logins included.** One concept, but running an Agent kept in a project repository would ask for a login again and write tokens into that repository. `MITOME_HOME` already isolates Mitome's own config and state.
- **Search the current directory for a Configuration.** Typing `mitome` in an untrusted repository would run its code.
- **One generator for both audiences.** `npm create mitome` writing a Configuration served neither: someone building an application got a command-line Configuration, and the default needed a path argument and a manual install.
- **Keep `--app` mandatory.** Every other harness opens its terminal from the bare command.
- **Other names for the selector:** `--app` came from a source term; `--agent` and `--profile` take names, not paths, elsewhere; `--use` says nothing about what is used.

## Consequences

This amends ADR-0010 (where the file lives), ADR-0013 (no `.env` in the config directory), [ADR-0023](0023-separate-project-and-default-agent-bootstrap.md) (the scaffolder writes an application that embeds an Agent, not a Configuration), [ADR-0030](0030-let-mitome-home-override-the-config-directory.md) (`MITOME_HOME` also holds state) and ADR-0057 (a default Configuration exists). Saved conversations will also live outside the config directory.

The first implementation does not yet reconcile dependencies; a missing installation reports the command to run.
