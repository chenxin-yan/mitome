---
status: amended by ADR-0027, ADR-0030
---

# Load the default Definition from XDG config

Mitome loads `$XDG_CONFIG_HOME/mitome/agent.ts`, falling back to `%APPDATA%\mitome\agent.ts` on Windows and `~/.config/mitome/agent.ts` elsewhere, and only loads another Definition through `--use <path>`, which must point to an explicit TypeScript entry-point file, never a directory. This avoids implicitly executing project-local TypeScript and postpones a project trust subsystem. `XDG_CONFIG_HOME` wins on every platform so one variable relocates config everywhere.
