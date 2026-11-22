# create-mitome

Scaffolds an application that embeds a Mitome Agent as a library: `src/agent.ts` describes the Agent with `Agent.make` and one small Extension whose Tool needs Approval, and `src/main.ts` runs one Turn of it with a first-party Provider from `@mitome/providers` (OpenAI, OpenAI Codex or Anthropic), asking on the terminal when a Tool Call needs Approval.

```sh
npm create mitome my-app
```

The generated README says how to set the credential and run it (`npm start -- "roll a die"`). For a personal Agent in the terminal instead, use `mitome init` from `@mitome/cli`.

The `create-mitome/template` export is internal plumbing with no stability guarantee.
