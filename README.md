# Mitome

Mitome lets you define and run AI agents for your own use cases. Use the Promise-first SDK in applications; use the CLI and an explicitly composed Host for terminal workflows.

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

See the [documentation](apps/docs/content/docs/) for the quickstart, authentication, interactive TUI, Extensions, Transcript persistence, Providers, and Effect-native API.

## Development

Install [mise](https://mise.jdx.dev/getting-started.html), then run `mise trust`, `mise install`, and `bun install`. Use `bun run dev:cli` for the CLI or `bun run dev:docs` for the docs site.
