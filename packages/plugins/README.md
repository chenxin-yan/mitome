# @mitome/plugins

First-party static Instructions Plugins for Mitome Agents.

```sh
npm install @mitome/sdk @mitome/plugins
```

Use `instructions("You are a helpful Agent.")` for inline markdown, or
`instructionFiles({ paths: ["./instructions.md"] })` for files next to the defining module.
`instructionFiles({ discover: ["AGENTS.md"] })` searches from the cwd to the git root;
explicit paths fail when absent, while discovered names are optional.

Each factory has a fixed Plugin name; configure at most one of each in an Agent Definition.
