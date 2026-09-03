# Keep the Promise surface Effect-free

No type imported from `effect` appears in a public signature of `@mitome/sdk` or `@mitome/sdk/extensions`. `@mitome/sdk/effect` is the sole exception. Mitome-owned `Prompt`, `ResponsePart`, `FinishReason`, and `Usage` types mirror the model values that cross the Promise boundary. Promise Hooks receive those types; adapters translate them to and from Core's Effect-native model types.

The root SDK accepts a Promise-returning `TranscriptStore`. A missing `load` returns `null`; its adapter maps that value to `TranscriptNotFound` and rejected Promises to `StoreError`. The Effect-returning Core store remains canonical on `@mitome/sdk/effect`.

Schema-tagged Core errors remain the errors thrown by the Promise surface. They are ordinary `Error` subclasses with `_tag`, so duplicating them as plain classes would lose runtime identity without removing Effect from user signatures.

This boundary insulates ordinary applications and Extension authors from unstable Effect AI types while preserving one runtime and error model underneath both SDK entry points.
