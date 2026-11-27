# Mitome

A TypeScript library and command line for user-defined AI Agents, built on Effect.

**Prerelease; nothing is published to npm yet.** Implemented today, in one process and in memory: an Agent described as data with `Agent.make` and `Extension.make`, a Configuration that names it with its Providers and Model (`Mitome.make`), Sessions that run it (`Session.make(agent)`), OpenAI, OpenAI-compatible, Codex and Anthropic Providers, the `mitome` command (a terminal that answers Approvals, and one-shot `mitome run`), and two ways to start: `mitome init` writes the default Configuration for the `mitome` command, and `npm create mitome` writes an application that embeds an Agent. Streaming, saved history, Channels and first-party Extensions are not implemented yet.

- [Documentation](https://mitome.sh/docs): [Agents and Configurations](https://mitome.sh/docs/agents), [CLI](https://mitome.sh/docs/cli) and [contributing](https://mitome.sh/docs/contributing).
- [MVP plan](docs/plans/mvp-plan.md): what this stack implements and what comes after.
- [Library plan](docs/plans/effect-native-library.md): the longer-term direction and its open contracts.
- [Architecture decisions](docs/adr), from [ADR-0058](docs/adr/0058-describe-an-agent-as-data-and-run-it-through-a-configuration.md) to [ADR-0068](docs/adr/0068-let-an-extension-name-its-commands.md) for the current design.

MIT licensed; see [LICENSE](LICENSE).
