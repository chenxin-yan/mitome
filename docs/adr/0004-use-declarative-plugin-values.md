---
status: amended by ADR-0024, ADR-0049
---

# Use declarative Plugin values

A Plugin is a plain typed value that may contribute an Effect AI Toolkit, lifecycle Hooks, and a fully provisioned Layer for scoped resources; Plugins run in Definition order and do not wire dependencies into one another. MVP Hooks cover Session, Turn, and Step notifications, pre-Step context transformation, pre-Tool veto, and post-Tool result transformation. Hooks run sequentially in Definition order, and a Hook failure fails the Session startup or current Turn unless the Plugin explicitly recovers; the exception is Session-end Hooks during teardown, whose failures are logged and suppressed so cleanup always completes. A pre-Tool veto or user-denied Approval skips execution, returns the same typed denial result with its reason to the model, and allows the Turn to continue. A transformed Tool result is revalidated against the Tool’s existing success or failure schema before entering Session history. Every Plugin has a required stable name; duplicate Plugin or Tool names reject the Definition before Session startup. Mitome still uses Effect v4 Model, Tool, Toolkit, and Chat directly rather than wrapping them.
