# Releasing Mitome

All public packages, including the eight platform binaries, share one Changesets fixed version. The GitHub release uses one `vVERSION` tag. Bun packs workspace/catalog dependencies; npm uploads the resulting tarballs using trusted publishing.

## Changesets in pull requests

For changes that need a release, run `bun run changeset` from the repository root, select the affected public packages and semver bumps, and write a user-facing summary. Commit the generated `.changeset/*.md` file with the change. Changesets expands the fixed release group during versioning; do not manually bump every package. Preview the pending release with `bun run changeset status --verbose`.

Docs, tests, and tooling changes that do not affect published behavior may omit a changeset. Explain that decision in the PR; reviewers still decide whether a release and the selected version bumps are appropriate. An empty changeset (`bun run changeset --empty`) is optional, not required.

[`Changeset Status`](../.github/workflows/changeset-status.yml) uses the official `pr-status` and `pr-comment` actions to create/update a non-blocking PR comment, including on fork PRs. Missing changesets do not fail the check. It skips `changeset-release/` branches because versioning consumes changesets; normal CI still verifies those PRs.

The reminder uses `pull_request_target`, reads PR files without executing them, and isolates comment write permission in a separate job with no checkout. Do not add PR-head checkout, dependency installation, or project scripts to this workflow. Use this workflow **or** the hosted Changeset Bot, not both, to avoid duplicate reminders. Do not make the reminder a required merge check.

## Normal flow

1. Include a changeset with releasable changes and merge the PR.
2. `Release` selects versioning or publishing through Changesets and calls the reusable CI workflow for the selected commit. Changesets creates/updates `changeset-release/main` only after verification succeeds.
3. On the version PR, approve GitHub's pending workflow runs if prompted, check CI, and merge. The default GitHub token does not start these runs unattended. For unattended runs, configure a GitHub App and pass its narrowly scoped token through the version action's `github-token` input; setting a `GITHUB_TOKEN` environment variable is not equivalent.
4. Release builds all binaries, packs all packages, and checks the exact tarballs with the existing release fixtures plus an npm-installed CLI smoke. This job has read-only repository permissions and no OIDC permission.
5. The `release` environment's upload job downloads that run's immutable artifact by ID, verifies its source and contents, checks npm for existing versions, and uploads only missing versions. It does not install project dependencies, build, repack, or run npm lifecycle scripts.
6. A separate job confirms the entire cohort exists on npm, creates/verifies the version tag and GitHub release, then deploys docs from the same source commit.

CI also runs on PRs. Main-branch verification runs through `Release`, avoiding a second independent push-triggered CI run. A red verification job blocks publication even if branch protection is misconfigured.

## Owner setup before publishing

These settings are outside the repository and are not provisioned by the workflow:

- Configure **each** public package's npm trusted publisher for owner `chenxin-yan`, repository `mitome`, workflow filename `release.yml`, and environment `release` if using an environment restriction. Include every platform package and `create-mitome`.
- Enable direct **`npm publish`**, not only `npm stage publish`. New npm trusted publishers default to stage permission; Changesets does not currently support staged publishing.
- Use npm's recommended “Require two-factor authentication and disallow tokens” policy after trusted publishing is verified. No `NPM_TOKEN` is needed by this workflow.
- Create the GitHub `release` environment, restrict deployment to `main`, and configure required reviewers if releases should need approval. Merely naming an environment in YAML does not add approval protection.
- Require the PR CI verification check in the `main` ruleset. Enable “Allow GitHub Actions to create and approve pull requests.” Approve bot PR workflow runs, or provision the App token described above.
- Keep the existing Cloudflare token/account secrets for docs deployment.

For npm policy verification, use owner confirmation or redacted settings screenshots; do not paste tokens into an issue or PR. All current package names already exist. A new name may need an authorized initial manual publication before configuring its trusted publisher.

## Recovery

Release runs are serialized and do not cancel an active publisher. npm versions are immutable; the release checks skip already-published versions, but never treat a registry/network error as “missing.”

### Upload failed partway through

Prefer **Re-run failed jobs** on the original run. It reuses the successfully checked artifact and skips versions already uploaded. Artifacts are retained for 30 days.

If the artifact expired, re-run **all jobs** on the original run to rebuild and check its source. A fresh dispatch on `main` can also retry the current event commit:

```sh
gh workflow run release.yml --ref main
```

Uploads must use the workflow event's SHA: npm provenance reads `GITHUB_SHA`, not the checked-out HEAD. A new dispatch cannot upload a historical checkout under a newer event's provenance. Use the original run for historical uploads; `release-sha` is for finalize-only recovery below.

Do not edit already-published package contents and attempt to replace the same version: publish a new version for those changes. A tooling-only repair can use a newer source commit only when it does not change already-published artifacts, no conflicting cohort tag exists, and the new commit is the workflow event's source.

### All npm uploads succeeded, but tagging or docs failed

Prefer re-running the failed jobs. If Changesets now reports no unpublished packages, use explicit finalization:

```sh
gh workflow run release.yml --ref main \
  -f release-sha=FULL_RELEASE_COMMIT_SHA \
  -F finalize-only=true
```

The SHA must be a full commit ID reachable from `main`, with no pending release changesets. This reruns CI and verifies the full npm cohort, repairs the tag/release if absent, and deploys docs from that commit. It does not upload packages. Existing tags must resolve to the selected source commit; the workflow never moves them. Always use the original release source, not whatever happens to be the latest `main` commit.

Recovery is limited to commits containing the release tooling. A dispatch from a branch other than `main` is skipped.

## Local checks (no publishing)

```sh
bun run test
bun run --cwd packages/cli build:release
artifacts=$(mktemp -d)
node scripts/release.ts pack "$artifacts"
MITOME_RELEASE_ARTIFACTS="$artifacts" bun run test
```

`bun run test` runs every workspace's tests, including the private `scripts/` workspace's release tooling and tarball/install fixtures. Turbo builds their workspace dependencies first. Script tests are uncached because the fixtures also inspect temporary artifacts outside the workspace.

With `MITOME_RELEASE_ARTIFACTS` set, the same command checks the supplied tarballs instead of packing new JS archives, and also installs the packed CLI with npm and executes its launcher. CI exercises Linux x64/glibc; cross-compiling and checking the other tarballs does not prove runtime compatibility on every target. The scripts never upload unless explicitly invoked with `publish`.

## Sources

- [Changesets automation and permission separation](https://changesets.dev/guide/automating)
- [npm trusted publishing requirements and allowed actions](https://docs.npmjs.com/trusted-publishers)
- [GitHub bot-created PR workflow approval](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)
- [Investigation and baseline comparison with Crust](research/release-ci-comparison.md)
- [PR reminder recommendations and source review](research/changesets-pr-status.md)
