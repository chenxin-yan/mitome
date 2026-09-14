---
"@mitome/cli": patch
---

`mitome auth login` and `mitome auth logout` no longer hang on a Mitome Definition that leaves an interval or server running: every disposable Child Host inspection now exits as soon as its result is written and is bounded by a deadline. CLI diagnostics render an error whose `cause` points back at itself as `[circular cause]` instead of recursing.
