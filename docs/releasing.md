# Releasing

Before the first release, a maintainer must claim and verify ownership of the `@mitome` npm scope and all four names (`core`, `sdk`, `providers`, `cli`), configure each package's trusted publisher for `.github/workflows/release-pr.yml`, and protect the `release` GitHub environment. Those remote actions are deliberately not automated locally.

Add a changeset with `bunx changeset` to each pull request that changes a public package. Merges to `main` create or update the version PR. Changesets bumps all four packages together, updates exact Core peer dependencies and changelogs, and refreshes `bun.lock`.

Merging the version PR runs the release gates, creates the matching `vX.Y.Z` tag, publishes Bun-packed tarballs through npm trusted publishing, and attaches the checksummed CLI binaries to the GitHub Release. Retry a failure that occurred before tag creation by dispatching **Release PR** with the existing package version.

Bun blocks dependency postinstall scripts unless the consuming project trusts them. Consumers that install `@mitome/cli` with Bun must add `"trustedDependencies": ["@mitome/cli"]` to their `package.json` before `bun install`; that postinstall downloads the checksummed platform binary. Native Windows verification remains external-pending (issue #15).
