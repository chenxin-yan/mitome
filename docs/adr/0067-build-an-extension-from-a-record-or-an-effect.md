---
status: accepted
---

# Build an Extension from a record, or from an Effect that returns one

An Extension is a name and what it adds. What it adds is given either as a record, or as an Effect that returns the record:

```ts
export const clock = Extension.make("clock", {
  tools: ClockToolkit,
  handlers: ClockToolkit.of({ now: () => Effect.sync(() => new Date()) }),
});

export const todo = Extension.make(
  "todo",
  Effect.gen(function* () {
    const todos = yield* Ref.make<ReadonlyArray<string>>([]);
    return {
      instructions: "Keep a todo list for multi-step work.",
      tools: TodoToolkit,
      handlers: TodoToolkit.of({
        todo_add: ({ text }) =>
          Effect.as(
            Ref.update(todos, (list) => [...list, text]),
            "added",
          ),
      }),
    };
  }),
);
```

The record holds `instructions`, `tools` with their `handlers`, `policy` and `commands` ([ADR-0068](0068-let-an-extension-name-its-commands.md)). The Effect is the Extension's setup. It runs once when a Session starts, in that Session's Scope, so what it acquires lives as long as that Session. A conversation can outlive a Session: continuing a stored conversation opens a new Session, which runs the setup again, so history is restored and what a setup held in memory is not. State a feature keeps is a local variable of the setup, which the handlers close over. This is Effect's own way to build a service, `Layer.effect(Tag, Effect<implementation>)`, and the way [Alchemy](https://alchemy.run) builds a resource that needs others.

The earlier shape, `Extension.make({ name, tools, handlers, layer, instructions, policy })`, had two ways to prepare something before the handlers ran: `handlers` could itself be an Effect, and `layer` built services for them. Both are gone, replaced by the one setup. An Extension therefore no longer provides services to the Agent's own program; services a program needs come from the Configuration.

**Declare what exists; reach abilities through services.** What an Extension adds to the Agent is declared in the record, because it must be listed, ordered, type-checked and checked for clashes: the Tool types still reach the Agent's `policy` and `program` through the record's type, and Instructions are joined in `use` order whatever the timing of the setups. Everything else an Extension does, it does by asking for a service in its setup: the Configuration's services, and the abilities a Host offers. A Host's ability is a service that is absent unless that Host is running the Agent, as the `Approver` and `Transcripts` already are, so one Extension can add Tools everywhere and a panel only in a terminal. `Extension` never gains a field that belongs to one Host.

An Extension is code the Agent's author chose to run in the Agent's own process. Keeping the `Approver` and `Transcripts` out of the services its code is given stops them being reached by accident; it is not a sandbox against code that reads the runtime's internals.

The same rules shape every constructor, so that one is learned and the rest are guessed:

- `Thing.make` defines a concept (`Agent`, `Extension`, `Command`, `Provider`, `Mitome`); a lower-case function plugs in a ready-made piece and takes its options as one record (`openai()`, `jsonlTranscripts({ directory })`, `terminal({ keys })`). A published Extension is such a function too, called even when it takes no options, so that adding one later breaks nobody.
- A named thing takes its name first and one record after it, as Effect's `Tool.make` does. `Provider.make(id, { modelIds, credential, provision, models })` replaces five positional arguments.
- A collection is a list of values (`use`, `providers`, `commands`); a map is used only where the key is the point.
- Where a thing is built at run time, its record may come from an Effect. Today that is the Extension.

`Agent.make` and `Mitome.make` stay records. A Host reads an Agent before any Session exists (the command line parses its input with the Agent's text mapping first), and an author builds on a published Agent by spreading it; a Configuration is read without being started by the commands that list Providers and sign in. Accepting an Effect for the Agent later would break no caller, and is where a program's own per-conversation state would go.

A Configuration's `layer` is renamed `provide` and accepts one Layer or a non-empty list, the shape `Effect.provide` and `Layer.provide` accept in Effect 4.1.6. The Agent uses Extensions; the Configuration provides services. The two are different kinds of value and are never mixed: an Extension is a feature that travels with the Agent to every Host, and a Layer is infrastructure each deployment chooses. An Extension asks for a service, a Layer supplies it, and a Configuration that leaves one out does not compile.

## Considered options

- **An Extension as only an Effect that registers what it adds through an API.** Alchemy shows this can stay declarative when registering runs nothing. But the Tool types would reach the Agent only by passing them through the Effect's requirements, and nothing here needs it: returning the record gives the same setup, local state and run-time discovery, and keeps the types.
- **Keep the record with a `layer`.** A feature's state then needs a service class and a Layer where a local variable does, and a Tool set that is only known after connecting to a server, as with MCP, cannot be written at all.
- **`use` and `provide` as yields inside an Effect.** Yielding earns its place when one declaration needs another's result. Extensions are independent of each other, and a list keeps the Agent plain data whose Tool types, Extension names and record-form clashes are checked when it is built.
- **`layer`, `layers` or `dependencies` for the field.** The first is a singular noun holding a list, the first two are Effect vocabulary in a file edited by hand, and the last reads as packages. `provide` is the verb Effect itself uses and pairs with `use`.
- **A plugin system for each Host.** A Host's own additions reuse `Extension`; no second kind of value is introduced.

The surveys behind this are in [commands-and-bindings.md](../research/commands-and-bindings.md) and [configuration-layer-field.md](../research/configuration-layer-field.md).

## Consequences

This amends [ADR-0058](0058-describe-an-agent-as-data-and-run-it-through-a-configuration.md): an Extension is still a plain value an Agent lists, with the same composition rules, but what it adds may now be known only once a Session starts. `Agent.make` still refuses two Extensions with one name, whatever their form, and a Tool or Command named by two records. A clash that involves what a setup returns, and a malformed record from a setup, can only be found when that setup has run: they are reported when the Session starts, before any Turn. The option that record rejected, a Layer that registers what it adds, stays rejected: nothing here registers by side effect, and providing a service still does not expose a Tool.

Left for later, each as a service or a helper and none as a new field: a terminal interface service (status, panels, pickers), a service for watching a run's events, listing an Extension in one Host's own options, and removing or renaming one Tool or Command of someone else's Extension where it is listed.
