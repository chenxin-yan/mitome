---
"@mitome/core": minor
"@mitome/cli": minor
"@mitome/providers": patch
---

Add loadable native applications and the CLI that runs them. `@mitome/core` exports `defineMitome`, a typed producer that composes an ordinary program with shared infrastructure, Providers, a Default Model and ordered fallbacks, an explicit CLI mapping and optional serving Hosts, rejecting unclosed requirements at compile time. Its `acquire` builds infrastructure once, provisions the selected Model lazily, serves explicit fresh application-owned Sessions and shuts down by closing admission and draining work before releasing infrastructure.

The `mitome` CLI adds `run`, `providers` and `auth status|login|logout`, each loading the default export of an explicit `--app <file>`; `run` is one-shot with a `--grace` bound on shutdown. Codex credential errors now name `mitome auth login --app <file> --provider openai-codex`.
