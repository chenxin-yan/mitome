# Curate entry points by audience

Public API audience is selected by package: `@mitome/sdk` is the Promise-first app-developer facade, `@mitome/sdk/effect` is a curated Effect-native app-developer facade, and `@mitome/core` is the documented Effect-native Host and Provider author surface with a weaker stability guarantee.

Every entry point uses explicit named exports, and package source files may not use `export *`. This prevents internal Core plumbing and future exports from silently becoming public API.

This amends ADR-0022's complete Core re-export and undocumented-Core decisions.
