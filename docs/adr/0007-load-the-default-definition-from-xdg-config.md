---
status: amended by ADR-0027, ADR-0030
---

# Load the default Definition from XDG config

Mitome loads `$XDG_CONFIG_HOME/mitome/index.ts`, falling back to `%APPDATA%\mitome\index.ts` on Windows and `~/.config/mitome/index.ts` elsewhere, and only loads another Definition through an explicit `--use <path>`. A selected directory resolves only to its `index.ts` under ADR-0027. This avoids implicitly executing project-local TypeScript and postpones a project trust subsystem. `XDG_CONFIG_HOME` wins on every platform so one variable relocates config everywhere.
