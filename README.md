# Mitome

Mitome runs user-authored Agents in a local, interactive Session. Start with the Promise-first SDK; use Core directly only when you need Effect Layers, Streams, or scoped resources.

## Quickstart

Install the Bun-only CLI, then create and authenticate an OpenAI Definition:

```sh
bun add -g @mitome/cli
mitome init
# Enter gpt-5.4-mini, then an OpenAI API key when prompted.
mitome
```

`mitome init` writes `agent.ts` and its lockstep dependencies under `$XDG_CONFIG_HOME/mitome` (or `~/.config/mitome`) and stores the key in that config directory's `.env`. To change or rotate the saved API key later, run `mitome auth login`. Run `mitome` to start an interactive Session. The generated Definition is ordinary SDK code:

```ts
import { defineAgent } from "@mitome/sdk";
import { env, openai } from "@mitome/openai";

export default defineAgent({
  instructions: "You are a helpful Agent.",
  model: openai("gpt-5.4-mini", env("OPENAI_API_KEY")),
  plugins: [],
});
```

The CLI loads its config `.env` without replacing an already-set process variable. Never commit a Definition with a Credential value or copy a secret into an example.

- [Quickstart and SDK guide](apps/docs/content/docs/index.mdx)
- [OpenAI providers](apps/docs/content/docs/providers/openai.mdx)
- [Codex subscription setup](apps/docs/content/docs/providers/codex.mdx)
- [Core power-user surface](apps/docs/content/docs/core.mdx)
- [CLI host and trust boundary](apps/docs/content/docs/cli.mdx)

## Development

Install [mise](https://mise.jdx.dev/getting-started.html) and activate it in your shell, then run:

```sh
mise trust
mise install
bun install
```

Start the development server with `bun run dev`.
