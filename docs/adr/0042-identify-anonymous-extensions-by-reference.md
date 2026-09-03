# Identify anonymous Extensions by reference

An Extension's `name` is optional. An unnamed Extension is identified by its object reference: repeating the same value in an Agent Definition contributes it once, while separate unnamed values remain separate Extensions. This lets factories such as `instructions()` and `instructionFiles()` compose multiple configured instances without inventing caller-supplied names or special merge rules.

Named Extensions retain ADR-0035's conflict rule: two different values with the same name fail Agent Definition compilation. Names remain useful for diagnostics and package-oriented tooling, but they are not required for composition.

This amends ADR-0035's rule that names are always the runtime identity.
