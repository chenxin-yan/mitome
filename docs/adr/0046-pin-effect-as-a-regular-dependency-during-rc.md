# Pin Effect as a regular dependency during RC

Packages that run Effect depend on the exact Effect RC version as a regular dependency rather than declaring it as an exact peer. The workspace catalog remains the single owner of that pin. This also avoids peer-resolution failures for consumers of the current Promise-facing implementation; it does not preserve that authoring surface in the redesign.

Applications using Effect across Mitome's library boundary must use the same pinned version. This preserves Context tag, error, and runtime identity across library and Provider packages while Effect's release candidates may still break types between versions. [ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md) selects the canonical native surface; exact target exports remain pending.

When Effect 4 is stable, revisit this choice and prefer a compatible peer range if its stable-version guarantees make deduplication safe.
