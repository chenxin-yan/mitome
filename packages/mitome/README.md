# @mitome/core

Effect-native Agents, Extensions and Configurations, and the Sessions, Turns, controlled Steps, Provider contract and Approver they run on.

An Agent is plain data. Run it with `Session.make(agent)`:

```ts
import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { Agent, Extension, Session } from "@mitome/core";

const Shout = Tool.make("shout", {
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.String,
});
const ShoutKit = Toolkit.make(Shout);

const shouting = Extension.make("shouting", {
  tools: ShoutKit,
  handlers: ShoutKit.of({ shout: ({ text }) => Effect.succeed(text.toUpperCase()) }),
  instructions: "Use shout when the user asks for emphasis.",
});

export const agent = Agent.make({ instructions: "You are terse.", use: [shouting] });

// Still needs a Model: provide `Provider.model(provider, "model-id")` for any Provider.
export const answer = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* Session.make(agent);
    return yield* session.run("Say hello, loudly.");
  }),
);
```

`Mitome.make({ agent, providers, model })` names an Agent with the Providers and Model it runs with; that Configuration is what a Host such as the `mitome` command (`@mitome/cli`) loads.

See [Agents and Configurations](https://mitome.sh/docs/agents). A Session's history is a tree of Entries, one for each completed Step that had something to commit; it is kept in memory unless a `Transcripts` service is provided, as `jsonlTranscripts()` from `@mitome/transcripts` does. The conversation holds plain data, never live objects: a Tool's schema turns a live value (a `Date`, a class instance) into data, the kernel checks at the door that every Message it keeps is plain data (`isPlainData`) and serialises nothing, and each store chooses its own format for that data. Streaming is not implemented yet.
