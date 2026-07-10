---
status: superseded by ADR-0004 and ADR-0014
---

# Compose Effect AI primitives directly

The Mitome MVP owns the typed Agent Definition and CLI Session runner, while Definitions use fully provisioned Effect v4 Model, Toolkit, Tool, and Chat primitives directly. Definition authors satisfy provider, handler, HTTP-client, and secret dependencies; the CLI does not auto-wire them. We accept beta API churn rather than creating parallel provider, Plugin, Tool, or conversation abstractions with no distinct behavior.
