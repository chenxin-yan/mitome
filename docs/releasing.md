# Releasing

`bun scripts/release-preflight.ts` is read-only. Before the first release, a maintainer must claim and verify ownership of the `@mitome` npm scope and all six names, configure the trusted publisher for each package, protect the `release` GitHub environment, and create the version tag. Those remote actions are deliberately not automated locally.

Run `bun run release:dry-run` to execute local gates and print the publish order without contacting npm or GitHub.

Bun blocks dependency postinstall scripts unless the consuming project trusts them. Consumers that install `@mitome/cli` with Bun must add `"trustedDependencies": ["@mitome/cli"]` to their `package.json` before `bun install`; that postinstall downloads the checksummed platform binary. Native Windows verification remains external-pending (issue #15).

The release workflow uses `npm publish --provenance` with trusted publishing. Confirm npm's provenance behavior for that exact combination before the first remote release.
