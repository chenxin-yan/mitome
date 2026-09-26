---
status: amended by ADR-0027 and ADR-0057
---

# Separate project and default Agent bootstrap

Mitome has two bootstrap personas. `npm create mitome` scaffolds a visible Agent project in the current working directory; `mitome init` keeps scaffolding the hidden default Agent Definition under the XDG config directory established by ADR-0007. Neither command replaces or redirects the other.

The project scaffolder writes `package.json`, `index.ts`, `tsconfig.json`, and a README with install, authentication, run, and SDK embedding steps. It prompts from Provider Model hints generated from the models.dev snapshot, with a custom-ID escape hatch, with templates to follow the verified native composition contract of [ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md), not a permanent Promise/Effect audience split. It does not install dependencies or authenticate: those explicit next steps keep a portable Node `npm create` process separate from the Bun-native CLI.

This split follows framework conventions without making project-local Definitions implicit or trusted. The CLI still loads the XDG default unless the user supplies `--use ./index.ts`.
