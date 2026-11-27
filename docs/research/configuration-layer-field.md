# The `layer` field of a Configuration: one Layer or a list

Question: `Mitome.make({ agent, providers, model, layer })` takes one Effect Layer. Should it take a list, as `providers` and `use` do? Checked against Effect 4.1.5 as installed, 2026-11-26.

## What Effect itself does

- `ManagedRuntime.make(layer)`, the API closest to "a value that owns its services", takes one Layer (`dist/ManagedRuntime.d.ts:276`).
- `Effect.provide` takes one Layer, or a non-empty tuple of Layers (`<const Layers extends [Layer.Any, ...Array<Layer.Any>]>(layers: Layers, ...)`, `dist/Effect.d.ts`).
- `Layer.mergeAll(...layers)` is the combinator for independent Layers; `LayerMap.Service` takes `dependencies: ReadonlyArray<Layer>`.
- The Effect Solutions guide composes one `appLayer` with `Layer.provideMerge` and provides it once: `program.pipe(Effect.provide(appLayer))` (`effect-solutions show services-and-layers`). The rat-stack note the owner read does the same with `Layer.mergeAll` at the entrypoint.

## Measured

```
array:       a + b                   Effect.provide(program, [layerA, layerB])
mergeAll:    a + b                   Effect.provide(program, Layer.mergeAll(layerA, layerB))
dependent:   a + b built from a      Layer.merge(layerA, Layer.provide(layerB2, layerA))
```

An array's elements are independent: `Effect.provide(program, [layerA, layerB2])`, where `layerB2` needs `A` to be built, does not type-check (`This Effect requires a service that is missing from the expected Effect context: A`). A Layer that depends on another is wired with `Layer.provide` whichever shape the field has.

## Options

|     | Shape                          | For                                                                                                    | Against                                                                                                    |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| A   | `layer: Layer` (today)         | What `ManagedRuntime.make` takes and what the guides show; same as `Extension.make`'s `layer`; no work | Two services need `import { Layer } from "effect"` and `Layer.merge`                                       |
| B   | `layers: [Layer, ...]` only    | Reads like `providers` and `use`; no Effect import for independent services                            | Always a list; differs from `Extension.make`; the list hides that its elements cannot depend on each other |
| C   | `layer: Layer \| [Layer, ...]` | Exactly what `Effect.provide` accepts                                                                  | Two ways to write one thing; more type work in `Mitome.make`                                               |

Widening A to C later breaks nobody; narrowing back would.

## Rechecked for Host options (Effect 4.1.6, 2026-11-26)

The commands design puts a second kind of item in `layer`: a Host's options, such as the terminal's key bindings, next to a store such as `jsonlTranscripts()`. A starter Configuration then holds two independent Layers, which is the case option C was deferred for.

- In 4.1.6, four of Effect's own "provide" positions accept one Layer or a non-empty tuple of Layers: `Effect.provide` (`dist/Effect.d.ts:11887`, `:11996`), `Layer.provide`, `Layer.provideMerge` and a third `Layer` combinator (`dist/Layer.d.ts:1575`, `:1916`, `:2345`). The type is the same each time: `const Layers extends [Layer.Any, ...Array<Layer.Any>]`.
- `ManagedRuntime.make` still takes one Layer (`dist/ManagedRuntime.d.ts:276`), and the Effect Solutions guide still composes one `appLayer` and provides it once.
- The tuple's elements are merged, so they stay independent of each other; a Layer that needs another is still wired with `Layer.provide`.

Reading: `layer: Layer | [Layer, ...Layer[]]` is not a Mitome invention. It is the exact shape Effect accepts wherever a caller provides services, and it keeps the single form the guides show. A list-only field (option B) has no such precedent in Effect.
