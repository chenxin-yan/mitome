# Serialize Tool execution per Session

Mitome passes `concurrency: 1` to `streamText` so needsApproval evaluation, Tool handler streams, and their Hooks run sequentially per Tool call while model output still streams. Verified against Effect 4.0.0-rc.108, this option bounds streaming tool calls (effect#6596), with the whole per-call effect — needsApproval plus handler — inside one permit.

A Session-scoped one-permit semaphore previously enforced this while `streamText` ignored the option; it was removed when the pinned Effect version provided equivalent semantics. The invariant now depends on the Provider being built on Effect's `LanguageModel` (all current mitome Providers are); a Provider faking the Service directly is not serialized by mitome.
