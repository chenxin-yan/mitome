---
"@mitome/sdk": minor
---

Replace the `setup`/`dispose` pair on `defineExtension` with a single `resource({ defer })` callback. Call `defer` after each acquisition step succeeds; cleanups run in reverse registration order when the Session is released, including when a later step throws, so a partially acquired Resource no longer leaks. `dispose` without `setup` is no longer a definition-time error because the pair is gone; Hooks and Tools that use a Resource still require `resource`.
