# Serialize Tool execution per Session

Mitome wraps the composed Effect AI Toolkit with a Session-scoped one-permit semaphore so Tool handler streams and their Hooks cannot overlap, while model output still streams. This works around Effect through 4.0.0-beta.98 `streamText` ignoring its Tool `concurrency` option; remove the wrapper only after the pinned Effect version provides equivalent sequential semantics.
