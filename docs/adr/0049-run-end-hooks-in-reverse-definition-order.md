# Run end Hooks in reverse Definition order

Start Hooks (`sessionStart`, `turnStart`, `stepStart`) run in Agent Definition order. Their end counterparts (`sessionEnd`, `turnEnd`, `stepEnd`) run in reverse Agent Definition order, and so does the cleanup that runs end Hooks for the Extensions already started when a start Hook fails or a phase is interrupted midway. This mirrors how the Session Scope already released Extension Resources: last acquired, first released. An Extension that starts after another can therefore rely on that Extension's Resource still being intact during its own end Hook, which is the property nested setup and teardown normally guarantees.

Before this decision the documentation stated "Hooks run in Agent Definition order; teardown is reversed" while the implementation ran end Hooks in Definition order. The implementation was changed to match the documented contract rather than the other way round, because the reversed order is the one that composes.

This amends ADR-0004, which said Hooks run sequentially in Definition order without distinguishing start from end. Everything else in ADR-0004 about Hooks stands: they run sequentially, a failure fails startup or the current Turn, and Session-end Hook failures during teardown are logged and suppressed so cleanup always completes.

## Consequences

- Extension authors may assume their end Hooks run before those of every Extension declared earlier, and after those of every Extension declared later.
- The order in which `mitome ext list` prints Extensions is the start order; end order is its reverse.
- Tests that assert Hook ordering record both directions.
