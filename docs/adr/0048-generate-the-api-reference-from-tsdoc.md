# Generate the API reference from TSDoc

The documentation site carries a generated API reference for every published entry point: `@mitome/sdk`, `@mitome/sdk/effect`, `@mitome/sdk/extensions`, `@mitome/core`, the three `@mitome/providers/*` subpaths, and `@mitome/tui`. Each entry file declares its public import path with a `@module` tag, and TypeDoc with `typedoc-plugin-markdown` renders one page per module into `apps/docs/content/docs/reference/api/`. A small local plugin adds the `title` frontmatter fumadocs requires, flattens module names into stable slugs (`sdk-effect`, `providers-openai-codex`), rewrites cross-page links to rendered routes, and writes the sidebar `meta.json` in entry-point order. Documentation validation runs with warnings treated as errors, so an undocumented exported symbol fails the docs build instead of silently shipping a signature-only entry. `create-mitome/template` is `@internal` and has no reference page.

The repository pins TypeScript 7, which ships no JavaScript compiler API, and TypeDoc's peer range stops at TypeScript 6 ([TypeStrong/typedoc#3098](https://github.com/TypeStrong/typedoc/issues/3098)). The generator therefore lives in `tools/api-docs/`, a standalone project outside the Bun workspaces with its own lockfile that pins TypeScript 6; nothing else in the repository resolves it. TypeDoc reads package source directly and resolves `@mitome/core` through its built declarations: symbols reached through Core's declarations are documented on the first entry point that exports them and cross-linked elsewhere, while the `@mitome/core` page documents Core's own source.

The generated pages are git-ignored, like the model hints of ADR-0028. A Turbo root task `//#api:generate` depends on `@mitome/core#build`, declares the tool and source inputs, and produces the pages; the docs `build` and `dev` tasks depend on it, so `bun run build:docs` on a fresh clone generates the reference before Vite runs.

## Consequences

- A second lockfile (`tools/api-docs/bun.lock`) is committed and installed by the generator script, not by the root `bun install`.
- Every exported symbol of the eight entry points needs a TSDoc comment; the generator enforces this and the docs build is the gate.
- Generated pages are not reviewable in pull requests; the source comments are.
- When TypeDoc supports TypeScript 7, drop the separate TypeScript pin and fold the generator's dependencies into `apps/docs`.
