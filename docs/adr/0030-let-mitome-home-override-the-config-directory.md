---
status: accepted
---

# Let MITOME_HOME override the config directory

`MITOME_HOME` names the config directory verbatim (no `mitome` suffix, like `CARGO_HOME`) and wins over `XDG_CONFIG_HOME` and the platform fallbacks. Unlike relocating via `XDG_CONFIG_HOME`, it moves only Mitome: child processes and agent-spawned tools inherit no fake XDG root. The repo's `dev:cli` script sets it to the gitignored `.dev-home/` so source runs never touch the developer's real config; `bun run dev:cli init` bootstraps it through the normal code path.
