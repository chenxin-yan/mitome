---
"@mitome/core": patch
"@mitome/sdk": patch
---

Document the Transcript commit boundary precisely: a successful `save` plus the `history()` update commit a Turn, so a `StoreError` from appending the final `response-complete` event record arrives after the commit and replaces that event. `StoreError`, `Session.runTurn`, and the persistence guides no longer claim that every failed Turn is uncommitted. No runtime behavior changed; a regression test pins the post-commit case.
