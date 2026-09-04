---
"@mitome/core": minor
"@mitome/sdk": minor
---

Rename `Session.prompt` to `Session.runTurn` and `PromptOptions` to `TurnOptions`. Host authors receive the staged Message through `HostContext.message` instead of `HostContext.prompt`.
