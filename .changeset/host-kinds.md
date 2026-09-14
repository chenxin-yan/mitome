---
"@mitome/core": minor
"@mitome/sdk": minor
"@mitome/tui": minor
"@mitome/cli": minor
---

Make `Host` a union discriminated by `kind`: `interactive` Hosts own a terminal (`unsupported?`, `run`), and `channel` Hosts connect an external surface with a unique `name` plus `handle` and/or `serve`. A Mitome Definition may declare any number of Hosts; `mitome [message]` runs the first supported interactive Host in order and otherwise falls back to one-shot output, while Channel Hosts are validated but not yet served. `defineMitome` and the CLI reject a Host without a known `kind`, a Channel Host without `handle` or `serve`, or duplicate Channel names, naming the offending Host. `tui()` returns `kind: "interactive"`; the SDK types `hosts` as `{ kind }` handles so an uncalled factory fails compilation.
