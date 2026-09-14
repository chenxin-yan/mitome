# Discriminate Hosts by kind

`Host` in `@mitome/core` is a closed union discriminated by `kind`, and a Mitome Definition may declare any number of Hosts. An `interactive` Host owns a TTY process: `unsupported?()` and `run(context)`, where the context carries the Agent, the shared Transcript store, and the staged first Message. A `channel` Host connects an external surface: a unique `name` plus at least one of `handle(context, Request): Promise<Response>` (request-driven; the response body owns the Session scope until it ends or is cancelled) or `serve(context, AbortSignal): Promise<void>` (long-running; resolves only after shutdown). Its context carries the Agent and the shared Transcript store; there is no Message because a Channel receives its Messages from the surface it connects.

`mitome [message]` runs the first `interactive` Host in Definition order whose `unsupported()` returns undefined, reports each refusal on stderr, and otherwise uses the built-in one-shot printer; `--print` and a non-TTY stdout still force one-shot. Channel Hosts are validated but not served by ordinary invocation; a later `mitome serve` command will own them, and the Runner's dispatch across many Channels is deferred to that work.

Both `defineMitome` and the Runner's embedded loader validate the declaration: every Host has a known `kind`, a Channel Host exposes at least one capability, Channel names are unique, and an uncalled factory is still reported clearly. The Runner cannot trust imports from the Definition's dependency tree, so its validator is standalone and mirrors Core's messages. Every message names the offending Host by index or name. Because Mitome is prerelease, a Host without a `kind` is rejected rather than defaulted to `interactive`.

Each Host module owns its options: `tui({...})` and, later, `telegram({...})`. Nothing Host-specific lands on `defineMitome` or in `@mitome/sdk`, which types `hosts` as a shallow `{ kind: "interactive" | "channel" }` handle so an uncalled factory fails compilation while Effect stays out of the Promise surface (ADR-0045, ADR-0047).

This supersedes ADR-0039: the composition root stays explicit, but the single-mode Host and the at-most-one rule are gone. It amends ADR-0003's deferral of an HTTP server: a Channel Host may listen for requests once a concrete Channel needs it, though the CLI itself still ships no server. ADR-0040 is preserved: every Host of one Mitome Definition shares the store the Definition composed.

## Consequences

- Existing `hosts: [tui()]` Definitions behave as before; `tui()` now returns `kind: "interactive"`.
- Several interactive Hosts form an ordered fallback chain ending in one-shot output.
- A Host authored without `kind` fails both `defineMitome` and `mitome` with a message that names it.
- The CLI subprocess that loads Definitions is the Runner in the glossary; the code rename from Child Host is deferred.
