---
status: amended by ADR-0027, ADR-0030 and ADR-0057
---

# Load the default Definition from XDG config

The explicit module-selection trust boundary remains under [ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md); the selected module's native composition contract is pending. The current CLI loads `$XDG_CONFIG_HOME/mitome/index.ts`, falling back to `%APPDATA%\mitome\index.ts` on Windows and `~/.config/mitome/index.ts` elsewhere, and only loads another Definition through an explicit `--use <path>`. A selected directory resolves only to its `index.ts` under ADR-0027. This avoids implicitly executing project-local TypeScript and postpones a project trust subsystem. `XDG_CONFIG_HOME` wins on every platform so one variable relocates config everywhere.
