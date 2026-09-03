# Pin Effect as a regular dependency during RC

Packages that run Effect depend on the exact Effect RC version as a regular dependency rather than declaring it as an exact peer. The workspace catalog remains the single owner of that pin. Promise-only users therefore install no Effect package themselves and cannot hit peer-resolution failures caused by Mitome's internal runtime choice.

Applications importing `@mitome/sdk/effect` must use the same pinned Effect version. This preserves Context tag, error, and runtime identity across the facade and Provider packages while Effect's release candidates may still break types between versions.

When Effect 4 is stable, revisit this choice and prefer a compatible peer range if its stable-version guarantees make deduplication safe.
