# Rename Plugin to Extension and fold first-party Extensions into the SDK

The domain term Plugin is renamed to Extension across the public API, domain language, and code: `definePlugin` becomes `defineExtension`, the Definition field `plugins` becomes `extensions`, and Core/SDK types rename accordingly (`Plugin` → `Extension`, `PluginHooks` → `ExtensionHooks`). The package is pre-release, so no compatibility surface is kept. ADRs written before this decision use "Plugin" for what is now an Extension; they are not rewritten.

`@mitome/plugins` is deleted. Its two first-party Extensions, `instructions` and `instructionFiles`, move to the `@mitome/sdk/extensions` subpath, following the SDK's existing `./effect` subpath convention. Eighty-odd dependency-free lines did not justify a published package's release and documentation overhead (the same consolidation economics as ADR-0018), and the subpath keeps `node:fs`/`node:path` imports out of the SDK root barrel. Users now install only `@mitome/sdk` and `@mitome/providers`. A future first-party Extension with heavy dependencies should get its own package rather than growing the SDK's dependency list.

This amends ADR-0022's install surface and ADR-0024's packaging of first-party instruction Extensions.
