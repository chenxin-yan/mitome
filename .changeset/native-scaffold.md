---
"create-mitome": minor
---

`create-mitome` scaffolds an application that embeds an Agent as a library. `src/agent.ts` exports an Agent made with `Agent.make`, using a `dice` Extension whose `roll` Tool needs Approval; `src/main.ts` gives it the chosen Provider's Model, opens a Session, runs one Turn from the command-line text and prints the result, asking on the terminal when a Tool Call needs Approval, showing the parameters as the JSON the Model sent, and leaving it denied when nobody is at one. The project runs under plain Node (`npm start`) and type-checks with `npm run check`. Generated projects depend on `@mitome/core`, Anthropic is offered next to OpenAI and OpenAI Codex, and the README's Codex login step runs the Effect `login` returns and stores the Credential in Mitome's state directory. `create-mitome/template` exports the Provider choices, Model hints, Model id validation, pinned dependency versions and example Agent that `mitome init` shares.
