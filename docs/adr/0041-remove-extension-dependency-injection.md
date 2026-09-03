# Remove Extension dependency injection

Extension dependency injection is removed: Extensions no longer declare `dependencies` or `provides`, Promise Tool declarations no longer name cross-Extension service dependencies, and Promise Hooks and Tool handlers no longer expose `getService`. Agent Definition compilation neither auto-includes nor topologically orders Extensions. Resources are acquired in Agent Definition order and remain private to their owning Extension.

Tools and Hooks that share Session state belong in one Extension and access the same Resource. Independent Extensions are composed explicitly in the Agent Definition. This smaller contract removes a type-heavy graph with no non-test consumers; if cross-Extension services become a demonstrated requirement, they can return later as an additive design grounded in that use case.

This supersedes ADR-0035. It restores ADR-0004's no-wiring decision and re-defers ADR-0026's cross-Extension type dependencies. ADR-0032's Layer-inferred coverage remains within one Extension.
