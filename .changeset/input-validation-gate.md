---
"@mitome/core": patch
---

A failing Tool input validator now blocks execution and fails the Turn with `TurnError: Tool input validation failed`. Previously the failure only forced an approval prompt when a `needsApproval` predicate existed, and was silently ignored otherwise, letting the handler run with unvalidated params.
