---
"@mitome/core": minor
"@mitome/sdk": minor
"@mitome/tui": minor
"@mitome/cli": minor
---

`defineAgent` now accepts an `approvals` policy with `allow`, `ask`, and `deny` Tool-name patterns or a decision callback. The strictest Agent or Extension decision wins, and Agent `allow` bypasses the Tool's own approval predicate. Failed predicates require Host approval instead of running the Tool.

The TUI prompts for required approvals with `y`, `n`, or `a` to allow a Tool-requested approval for the current Session. Non-interactive runs deny requests by default; pass `--yes` to approve Tool-requested prompts for one invocation. Policy and predicate-error requests are never approved by `--yes`.
