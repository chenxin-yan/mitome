# Serialize Tool execution per Session

Mitome passes `concurrency: 1` to `streamText` so needsApproval evaluation, Tool handler streams, and their Hooks run sequentially per Tool call while model output still streams. Effect 4.0.0-beta.102 bounds streaming tool calls by this option (effect#6596), with the whole per-call effect — needsApproval plus handler — inside one permit.

A Session-scoped one-permit semaphore previously enforced this while `streamText` ignored the option; it was removed when the pinned Effect version provided equivalent semantics. The invariant now depends on the Provider being built on Effect's `LanguageModel` (all current mitome Providers are); a Provider faking the Service directly is not serialized by mitome.
