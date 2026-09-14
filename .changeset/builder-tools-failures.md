---
"@mitome/core": minor
"@mitome/sdk": minor
---

Replace standalone `tool()` declarations with scoped builders in `defineAgent({ tools })` and `defineExtension({ tools })`. Tools may omit `outputSchema`, or declare `failureSchema` and return `ok()` or `fail()` for expected failures.

Tool inputs are now validated and decoded once before hooks, approval checks, and handlers run. Invalid input returns an `execution-denied` result to the model, while validator defects fail the turn. SDK validation errors include every issue and available path.

`postTool` hooks now receive expected failures with `isFailure: true`. End hooks run in reverse Agent Definition order, including cleanup after failed or interrupted starts. The SDK Extension `setup` callback no longer receives an `AbortSignal`.
