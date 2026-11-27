---
status: accepted; amended by ADR-0067 and ADR-0068
---

# Describe an Agent as data and run it through a Configuration

An Agent is described by one value that knows nothing about where it runs: its Instructions, its Extensions, its Tool policy, an optional Agent program and how its input and result map to text. A separate Configuration names that Agent together with the Providers, the Model, the Hosts and the storage it runs with in one place. This replaces the single `defineMitome` composition of [ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md), which mixed the Agent, machine-specific wiring and one Host's settings in one object.

The split exists because the same Agent must run unchanged in a terminal, behind a Channel, embedded in an application, as a child in Delegation and in a test. Only the first two have a Configuration. The Agent program therefore belongs to the Agent, and leaving it out selects the default loop; the Model belongs to the Configuration, so the Agent stays Model-agnostic and the Qualified Model id is checked against the Configuration's own Providers. A schedule is a Host whose Messages come from a timer.

An Extension is a plain value that describes what it adds, merged into the Agent before anything starts. It contributes in four ways, each with one composition rule: it adds Tools and Instructions (a duplicate Tool name is rejected, not prefixed); it decides Tool Calls through policy (deny beats ask, ask beats allow, as in [ADR-0051](0051-let-the-agent-author-decide-tool-approvals.md)); it shapes the Model Context for one Step, in the order Extensions are listed; and it watches events without being able to affect the run. Committed history is never edited, only branched, and an Extension can never rewrite a Tool Call's arguments, because an Approval is bound to the exact arguments.

There is no Extension registry, event bus, load-order rule, directory discovery or install command. An Extension is a package the author imports. Because Agents and Extensions are plain values, an author overrides part of one or builds on a published Agent with ordinary code.

Constructors follow Effect's own naming: `Agent.make`, `Extension.make`, `Mitome.make`, `Session.make` and `Provider.make`. Effect 4.0.0 has no `define…` constructor; its `HttpApi` is the precedent for the whole shape: "An `HttpApi` value is data… The same description can be used by server builders, generated clients…".

## Considered options

- **An Extension is a Layer that registers what it adds.** This is how Effect's `McpServer.toolkit` works, and it needs no new type. A prototype against Effect 4.0.0 showed three costs: what an Extension adds is known only after its Layer is built, so listing Tools would open connections; merged Layers build concurrently, so the order of Instructions changed with startup timing; and the registry erases Tool types. It would also reverse ADR-0057's rule that providing a service does not expose a Tool.
- **No Extension concept, only separate fields.** Each package would be wired in three places with nothing tying them together.
- **Hooks that mutate, as in pi.** pi documents the cost: handlers run in load order and may change values for later handlers.
- **The Model on the Agent.** Rejected because the Providers live in the Configuration, where the id can be checked.

## Consequences

This amends ADR-0057: the function-first Agent program, native Tool, Toolkit and Layer types, and "providing a service does not expose a Tool" all stand; `defineMitome` and its `cli`, `configDirectory` and `hosts` fields do not. It returns to the declarative values of [ADR-0004](0004-use-declarative-plugin-values.md) and the Extension name of [ADR-0034](0034-rename-plugin-to-extension-and-fold-first-party-extensions-into-the-sdk.md) without their Hooks, and keeps [ADR-0041](0041-remove-extension-dependency-injection.md)'s refusal to build a second dependency graph: an Extension that needs another declares an ordinary Layer requirement. Under [ADR-0050](0050-discriminate-hosts-by-kind.md) Host options still belong to the Host; Hosts are now named by the Configuration, never by the Agent.

Shaping the Model Context and watching events need support in the Step that streaming also needs ([ADR-0062](0062-stream-for-display-only.md)); the first implementation carries only added Tools, Instructions and policy. Policy merging beyond the fixed rule, saved Extension state and Host-side contributions such as commands are not yet designed.
