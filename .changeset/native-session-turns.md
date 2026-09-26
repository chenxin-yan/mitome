---
"@mitome/core": minor
"@mitome/sdk": minor
---

Replace the Agent Definition-bound Session engine with native Sessions and whole-function Turns. `makeSession({ persistence })` allocates a fresh scoped Session, with an explicit `SessionStore` or `"none"`; `Session.run(program)` runs any Effect as one Turn, preserving its result, error and requirement types, and the ambient `Turn` stages Messages that commit once after the program, its cleanup and any save succeed. Uncertain saves fence the Session with `SessionFencedError`. `createSession`, `createHostSession`, `CreateSessionOptions`, `TurnOptions` and the SDK's Promise `withSession` are removed; `@mitome/sdk/effect` exports the native Session API.
