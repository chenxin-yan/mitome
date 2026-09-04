# Author Tools through a scoped Extension builder

Promise-first Tool declarations live inside `defineExtension({ tools: ({ tool }) => [...] })` or the equivalent `tools` field on `defineAgent`. The scoped builder binds the Extension Resource once, preserves literal Tool names, and infers Tool input and output without per-Tool generic arguments. The standalone `tool()` factory is removed. `defineExtension` is the only documented Extension authoring form; structurally valid literals remain an internal implementation option, not a second public convention.

The shareable unit is an Extension. Authors should extract plain logic before extracting Tool declarations. When one Extension is large enough to split declarations across files, a plain function accepting the exported `ToolBuilder<Resource>` type is the escape hatch.

ADR-0026's Contributions phantom remains useful and is extended rather than removed: each contributed Tool now preserves its input, output, and expected-failure types. The flat-record guardrail remains. The scoped builder fixes the former name widening and Resource inference problems without adding a conditional-type tower.
