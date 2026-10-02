# Mitome

A TypeScript library and CLI/TUI for user-defined AI Agents.

**Redesign in progress.** The accepted direction is Effect-native, function-first authoring with optional Host composition. The process-local native library (Sessions, Turns, controlled Steps, Providers and `defineMitome` applications) and the `mitome` CLI, with one-shot `run` and the standalone `tui`, are implemented; durable storage, attached TUI and HTTP Hosts are not. Obsolete prerelease guides have been removed.

- [Library plan](docs/plans/effect-native-library.md): accepted direction, open contracts, and full replacement gates.
- [Architecture decision](docs/adr/0057-use-effect-native-functions-and-optional-host-composition.md).
- [Delivery roadmap #174](https://github.com/chenxin-yan/mitome/issues/174).
- [Documentation](https://mitome.sh/docs) and [contributing](https://mitome.sh/docs/contributing).

MIT licensed; see [LICENSE](LICENSE).
