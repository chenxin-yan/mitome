---
"@mitome/cli": minor
"@mitome/cli-darwin-arm64": minor
"@mitome/cli-darwin-x64": minor
"@mitome/cli-linux-arm64": minor
"@mitome/cli-linux-arm64-musl": minor
"@mitome/cli-linux-x64": minor
"@mitome/cli-linux-x64-musl": minor
"@mitome/cli-win32-arm64": minor
"@mitome/cli-win32-x64": minor
---

Add the `mitome` CLI, which loads a Configuration and runs it. Every command but `init` loads one Configuration, the default export of `Mitome.make(...)`: `index.ts` in the config directory (`$MITOME_HOME`, else `$XDG_CONFIG_HOME/mitome`), or the directory (its `index.ts`) or file given with `--config`, resolved against the invocation directory. The current directory is never searched. A missing default Configuration names its path and says how to select another; a Configuration whose packages are not installed names the directory to install them in and the install command `mitome init` prints; an installed package that fails to resolve, such as an unexported subpath, keeps the resolver's own diagnostic.

`mitome run` reads one input (the argument, else all of non-terminal stdin), maps it through the Configuration's `text.parse`, runs one Turn, and writes only the result of `text.render` to stdout, with a `--grace` bound on shutdown. It provides no Approver, so a Tool Call that needs Approval is denied, the Model is told, and the command finishes. Each run starts a new conversation under the working directory; `mitome run --continue` continues the one most recently written there and `--continue=<id>` the one with that id, saying on stderr which it continued and how many Entries it has. Only a Configuration that provides `Transcripts` keeps conversations: otherwise, or when there is none to continue, `--continue` fails and says so. `mitome providers` lists Providers and Model hints offline, and `mitome auth status|login|logout` reports or changes Provider credentials. Codex logins are stored in the state directory (`$MITOME_HOME`, else `$XDG_STATE_HOME/mitome`) and shared by every Configuration; the Anthropic sign-in stays in Anthropic's config directory. The binary ships for macOS, Linux (glibc and musl) and Windows on x64 and arm64. The binary shuts down within its grace on SIGINT, SIGTERM and SIGHUP alike, so closing its terminal also cleans up, and the npm launcher passes each of them on to it and exits with its status, except on Windows, where a console Ctrl+C or close already reaches the binary. Windows ends a process whose console closed after its own short timeout, so there a close starts the cleanup and no grace can guarantee it finishes.
