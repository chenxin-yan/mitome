---
status: amended by ADR-0015 and ADR-0035
---

# Build the CLI on the public in-process runtime

Mitome exposes its headless Session runtime as a TypeScript API, and the CLI consumes that same API. `createSession(Definition)` is a scoped Effect that allocates Plugin resources and returns a Session whose prompts stream typed Turn events. Sessions are process-local and ephemeral. Only one Turn may run at a time; overlapping `Session.prompt()` calls fail with a typed busy error rather than introducing persistence, queues, or steering. During an active Turn, Ctrl-C interrupts the scoped Session and exits the CLI rather than attempting partial-history recovery. The MVP does not add an HTTP server or generated client; those belong only when a concrete client requires them.
