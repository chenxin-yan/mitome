---
"@mitome/core": minor
"@mitome/sdk": minor
"@mitome/tui": minor
"@mitome/cli": minor
---

Add explicit `defineMitome({ agent, hosts })` composition with optional `hosts` and at most one Host. In automatic mode, the CLI runs the declared Host when supported and otherwise falls back to one-shot output. Declare `tui()` from `@mitome/tui` to enable the interactive Host; installing the package alone does not activate it.
