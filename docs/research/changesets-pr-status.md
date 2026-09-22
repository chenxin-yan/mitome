# Changesets PR status recommendations

Investigated September 22, 2026 against Mitome's installed CLI 3.0.1, Changesets action v2.1.2, and the current official automation guide. Operational instructions live in [Releasing Mitome](../releasing.md).

## Findings

- **No particular workflow filename is required.** The official guide recommends detecting changesets on PRs. It calls the hosted Changeset Bot the easiest option and also documents a repository-owned `pr-status` / `pr-comment` workflow. Its example filename is `comment-changesets-pr-status.yml`; `changeset-status.yml` is a local naming choice. [Automation guide][automation]
- **Missing changesets should not block contributions.** Docs/tests/tooling changes may not need releases. Upstream explicitly discourages a mandatory missing-changeset gate. Its own repository currently has `ci.yml`, `pkg-pr-new.yml`, and `publish.yml`, not a separate changeset-status workflow. [Automation guide][automation], [upstream workflows][workflows]
- **Use the official actions rather than a custom CLI wrapper.** `pr-status@v2` reads PR files using a temporary detached worktree and exposes `comment-body`; it needs a checkout but no dependency installation. `pr-comment@v2` creates or updates a comment using the default GitHub token and `pull-requests: write`. The documented two-job design keeps this write permission away from checked-out content. [Status action][status], [comment action][comment]
- **Fork support needs a careful trust boundary.** The official example uses `pull_request_target`, resets permissions, and never executes PR code. It skips `changeset-release/` branches because versioning consumes their changesets. Mitome adopts that example with its existing runner/checkout conventions, disabled persisted checkout credentials, timeouts, and per-PR concurrency. Normal PR CI remains separate. [Automation guide][automation]
- **A CLI status check is not a completeness check.** CLI 3.0.1 fails when versionable packages changed and there are no selected changesets; an empty changeset satisfies presence without releasing anything. It does not prove correct semver or coverage of every changed package. Missing changesets fail before `--output` is written, so treating every failed command or absent JSON file as a harmless missing-changeset reminder can conceal real errors. [Tagged CLI implementation][cli]

## Repository decision

Add `.github/workflows/changeset-status.yml` using the officially supported non-blocking action pair. This provides version-controlled PR feedback without requiring installation of another GitHub App. Do not also enable the hosted Changeset Bot for this repository, and do not make the reminder a required merge check. The absence of bot comments on an inspected PR does not establish whether the App is installed; the owner should confirm it is not configured to send duplicate reminders.

Keep the existing fixed release group, public access, disabled private-package versioning, custom Bun packing, and split CI/version/pack/upload/finalize jobs. These are already deliberate, documented choices; adding reminders does not require replacing them or changing dependencies. In particular, Bun packing resolves this repository's workspace/catalog dependencies before npm trusted publishing. See the [previous release investigation](release-ci-comparison.md) for that compatibility analysis.

Success criteria: absent changesets produce a reminder rather than a missing-changeset failure; ordinary PRs receive an updated comment; version PRs skip reminders but retain CI; no PR code executes with target-event privileges; only the comment job has write permission.

## Verification boundary

Local checks passed (exit 0): `nix shell nixpkgs#actionlint -c actionlint .github/workflows/changeset-status.yml`, `bun run fmt`, `bun run changeset status --verbose`, and `git diff --check`. Application build/typecheck/tests were not rerun because only workflow YAML and Markdown changed.

The source review and local checks establish the action contracts, workflow syntax, and current CLI behavior, not a live GitHub run. After merging to the default branch, verify comments on a normal PR with and without a changeset, a fork PR, and the version-PR exclusion. Bot installation and GitHub/npm owner settings are external to these files; no settings, releases, or packages were changed by this investigation.

## Sources

[automation]: https://changesets.dev/guide/automating#non-blocking
[workflows]: https://github.com/changesets/changesets/tree/main/.github/workflows
[status]: https://github.com/changesets/action/blob/v2.1.2/pr-status/README.md
[comment]: https://github.com/changesets/action/blob/v2.1.2/pr-comment/README.md
[cli]: https://github.com/changesets/changesets/blob/%40changesets/cli%403.0.1/packages/cli/src/commands/status/index.ts
