# Mitome

Mitome runs user-authored AI agents in local, scoped Sessions. Start with the Promise-first SDK; use the Effect facade only when you need Effect-native composition.

## Quickstart

```sh
npm install @mitome/sdk @mitome/providers
```

```ts
import { defineAgent, withSession } from "@mitome/sdk";
import { openai } from "@mitome/providers/openai";

const agent = defineAgent({
  providers: [openai()],
  model: "openai/gpt-5.4-mini",
  extensions: [],
});

await withSession(agent, async (session) => {
  for await (const event of session.prompt("Write a haiku about trees.")) {
    if (event.type === "model-output") process.stdout.write(event.text);
  }
});
```

Set `OPENAI_API_KEY` in the launching process. For CLI setup, an interactive Session, Extensions, Approvals, Effect usage, and credential guidance, read the [documentation](apps/docs/content/docs/index.mdx).

The supported public surfaces are `@mitome/sdk` and `@mitome/sdk/effect`; `@mitome/core` is an internal runtime dependency.

## Development

Install [mise](https://mise.jdx.dev/getting-started.html) and activate it in your shell, then run:

```sh
mise trust
mise install
bun install
```

Run the CLI with `bun run dev:cli` or the docs site with `bun run dev:docs`.
