---
"@mitome/core": minor
"@mitome/sdk": minor
---

Rename `Session.prompt` to `Session.runTurn` and `PromptOptions` to `TurnOptions`. Host authors now read the staged Message from `HostContext.message` instead of `HostContext.prompt`.
