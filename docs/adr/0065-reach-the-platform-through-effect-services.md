---
status: accepted
---

# Reach the platform through Effect's services, and let the Providers bind their own

`@mitome/providers` and `@mitome/cli` reach the file system, paths, child processes and standard input through Effect's services (`FileSystem`, `Path`, `ChildProcessSpawner`, `Stdio`), not through `node:` modules. A lint rule refuses `node:fs`, `node:child_process`, `node:http`, `node:readline`, `node:path` and their kin in both packages' sources.

The two packages get their implementations differently. The CLI is a Host and has its runtime's services at its root (`BunServices.layer`). The Providers supply their own: one file, `packages/providers/src/shared/platform.ts`, binds the services to Node's implementation from `@effect/platform-node-shared`, which Bun also runs, and the package provides that Layer at its own boundaries. So a Provider still requires nothing of whoever uses it, an Auth capability's `authenticate` still needs no service, and a Configuration or an embedding application names no platform.

## Considered options

- **The Host supplies the platform to the Providers.** It is the usual rule (the entrypoint chooses implementations), but a Provider's type, the Auth capability contract and the Configuration protocol would each gain platform requirements, and every embedding application would have to pick and provide a platform package. A Provider that needs a file to hold a login is not something its user should have to wire.
- **`@effect/platform-node`.** It also has an HTTP server, which would have put the sign-in callback server on Effect's `HttpServer`. At 4.1.6 it declares `redis` as a required peer and depends on `undici`, about 10 MB unpacked that every user of `@mitome/providers` would install and nothing would load.
- **Stay on `node:` modules.** The credential code, the part most worth testing against a substitute, stays outside Effect's services.

## Consequences

The Providers' `platform.ts` is the only file of theirs allowed to name Node, and it holds the one thing Effect's services cannot do: the sign-in callback server (`node:http`; an Effect server needs `@effect/platform-node`). A credentials file and its mode are read through one `File` handle, which can be a pipe, and the browser is started through `ChildProcessSpawner` and unreferenced, so that it outlives the login even when its launcher exits with a failure; both rely on fixes Effect made in 4.1.6. `mitome init` keeps one `node:fs` call, removing a directory only if it is empty, which `FileSystem` cannot express. Module resolution (`node:module`, `Bun.resolveSync`, `import()`) has no Effect service and is untouched. `@mitome/core` and `create-mitome` are outside this decision. `@mitome/transcripts` ([ADR-0066](0066-keep-history-as-a-tree-of-steps.md)) follows the Providers: it provides its own file system from one `platform.ts`, and the lint rule covers it.

`@effect/platform-node-shared` is the package Effect's own Node and Bun platform packages build on rather than the one its documentation names; it is versioned with `effect` and pinned to the same version. If a Host should one day supply the platform, the Providers already require the services internally: the change is to stop providing the Layer and let the requirement show.
