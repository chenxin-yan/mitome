---
status: accepted
---

# Ship one package, and gate what enters its core

Mitome ships as one `@mitome/core` package with subpaths, following Effect 4, which keeps `effect/ai`, `effect/http` and `effect/sql` in one package and publishes separately only what pulls in an outside dependency. The root entry holds the core. First-party Extensions without outside dependencies are subpaths of the same package. A separate package exists only when it brings a dependency most users do not need or npm requires it: the Providers (vendor SDKs), the CLI with its platform binaries and terminal Host, `create-mitome`, and later a database store and Channels with platform SDKs.

Every package was already released at one version, so separate packages bought nothing there, while they did cost something: a Provider is recognised only by the copy of the core that created it, and each extra package is another way to install two copies.

The core stays small by rule, not by package boundary. Something enters the root entry only if it passes these tests:

1. **Only the core can guarantee it.** A Turn commits whole or not at all; a Tool Call is checked before it runs.
2. **Separate packages must agree on it.** What a Provider is, what an Extension looks like, what a Host supplies.
3. **It makes sense however the Agent runs:** in a terminal, as a server, embedded in an application.

The first two are reasons to be in the core; the third is a veto. Interfaces go in the core and implementations go outside it. The third test removed three things: a status line from the interaction, a `cli` field that named one Host (replaced by a text mapping every text Host uses), and a `configDirectory` field that only the login commands used.

Inside the core, `session/` runs a conversation (Session, Turn, Step, Tool gating, limits, the Provider contract and the approver the gate asks) and never imports `agent/`, which describes an Agent and where it runs (the Agent, Extensions, Hosts and the Configuration). The root entry never imports a subpath. Lint rules enforce both.

The root entry holds what people write and what packages must agree on: the Agent, Extensions, Commands, the Configuration, the Provider contract, the Approver, the `Turn` and the errors. The layer underneath (a Session without an Agent, `step`, `loop` and `localTools`) is the subpath `@mitome/core/kernel`. An Agent's program is given a `step` and a `loop` that already carry the Agent's Instructions, Tools and policies; while the raw ones sat beside them in the root entry, a program that imported the raw `loop` compiled and ran without the Agent's Instructions. The kernel stays importable because a Provider's tests run a Step without an Agent and because another runtime can be built on it.

Neither entry carries something for a feature that is not built. Receipts for a finished Turn, a feed of finished Turns, a read of earlier Tool results and a last authority check before a Tool runs had no caller and were removed; streaming ([ADR-0062](0062-stream-for-display-only.md)) and durable execution ([ADR-0056](0056-separate-history-compaction-and-execution-recovery.md)) design what replaces them.

## Considered options

- **One package per feature**, as before. More names to version and install for no independent release.
- **A separate package for the conversation runtime alone.** Worth doing when someone needs it without the rest; nobody does yet.

## Consequences

This keeps [ADR-0034](0034-rename-plugin-to-extension-and-fold-first-party-extensions-into-the-sdk.md)'s packaging boundary (small dependency-free features need not each be a package, and heavy optional dependencies must not reach the root import) and [ADR-0018](0018-consolidate-providers-into-one-package.md)'s single Providers package. Entry points stay explicit under [ADR-0047](0047-curate-entry-points-by-audience.md). `@mitome/core` is renamed `mitome`. npm refused to register that unscoped name as too similar to `mime`, and a review is requested; if it is not granted, the one package takes a name under the `@mitome` scope and nothing else here changes.

## Amendment, 2026-11-23

npm refuses `mitome`, so the package is published as `@mitome/core` until that name is available, when it switches to `mitome`. "Core" in this record means what the root entry exports, not the package name. The three tests decide what is exported there, not which folder defines it: `session/` holds only what running a conversation needs, such as the Provider contract and the Approver the Tool gate asks, because it never imports `agent/`; a contract that describes an Agent or where it runs, such as an Extension or the Configuration, is defined in `agent/` and exported from the root entry like the rest.
