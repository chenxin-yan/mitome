# Release CI: Mitome, Crust, and Changesets

Baseline investigated September 18, 2026 local time / September 19 UTC, before the workflow update. The implemented process and recovery instructions are in [Releasing Mitome](../releasing.md).

## Verdict

**Update Mitome's release orchestration and verification, but do not copy Crust wholesale.** Keep mise, the fixed release group, Bun packing, npm trusted publishing, and the existing tarball checks. Adopt CI-before-publish and registry-aware release selection. Separate build/pack from the OIDC-authorized upload job.

Snapshots inspected:

- Mitome `bf6847a76a4c4e7509cc60f57301fb3935767727`.
- Crust `23ef4e994f8a0c5f0cdcdad6cf5eea2699cb20f9`.
- Installed Changesets CLI 3.0.1; local Bun 1.4.0, Node 26.7.0, npm 11.19.0.
- Changesets action `v2` resolved to `ae32849d5ba541f9ae29e40e22a623bc13562f51` (v2.1.2).

## How the repositories release

| Concern                   | Mitome                                              | Crust                                                                                 |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Version PR                | Combined Changesets action, configured version-only | Separate `select-mode` and `version` actions                                          |
| Publish eligibility       | Core version changed since the preceding push       | Changesets finds publishable packages with no pending changesets                      |
| Verification prerequisite | Separate CI workflow; publish does not depend on it | Calls reusable package CI before mode selection                                       |
| Package preparation       | Explicit dependency-order list; Bun packs tarballs  | Discovers/orders workspaces; Bun packs libraries; special scripts publish staged CLIs |
| Upload                    | npm publish with OIDC                               | npm publish with OIDC                                                                 |
| GitHub releases           | One `vVERSION` cohort tag/release                   | Changesets package tags/releases                                                      |
| Docs                      | After successful publish job                        | After action reports `published == true`                                              |

Sources: [Mitome release][mitome-release], [Mitome CI][mitome-ci], [Crust release][crust-release], [Crust publisher][crust-publisher].

## What Changesets officially recommends

The [automation guide][automation] and [action v2 README][action] recommend:

- Pending changesets → version PR; otherwise publish packages missing from the registry; otherwise do nothing.
- Individual sub-actions for trusted publishing, to tighten permissions. The combined action remains supported.
- Set `id-token: write` only on the publishing job. The illustrated setup separates build/pack from publishing, uses explicit job permissions, disables persisted checkout credentials, and avoids release dependency caching.
- Prefer npm trusted publishing over long-lived npm tokens.
- Use a GitHub App or personal token if version-PR CI must run automatically, passing it through the action's `github-token` input.
- Prefer non-blocking reminders for missing changesets rather than rejecting every contribution without one.

Two version-specific details matter:

1. Mitome's kebab-case v2 inputs are correct; the action defaults to `github.token`. Missing `GITHUB_TOKEN` environment configuration is **not** a bug.
2. Current GitHub docs say default-token PR creation/update can create **approval-required** runs for `opened`, `synchronize`, and `reopened`. The older categorical “never runs” wording in Changesets/Crust is too broad. An App token removes that manual approval requirement. [GitHub's authoritative behavior][github-triggers]

## Findings and recommended changes

### 1. High: require CI before publishing

Mitome's `publish` job depends only on `version-pr`. It runs builds and release fixtures, but does not await lint, full typechecking, or unit tests. Effective live rules for `main` contained only deletion/non-fast-forward protection, with no required checks. Release PR [#33][release-pr] had no CI verification check when inspected.

Make the existing CI workflow reusable through `workflow_call` and require it before upload. Reuse its commands instead of maintaining two verification lists; avoid duplicate main-branch CI after introducing the reusable call. Configure required PR checks separately. For the bot release PR, either intentionally approve runs or use a narrowly scoped GitHub App token.

A recent green [Mitome Release run][mitome-run] only ran versioning; publish and docs were skipped. That is not evidence the upload path works.

### 2. High: replace the push-to-push version detector

The core-version comparison is valid for today's fixed group, but ties recovery to one event:

- Rerunning the original version-change run can recover partial uploads.
- A later fix commit without another version change skips publishing, even if packages are still missing.
- There is no `workflow_dispatch` recovery entry point.

Use official `select-mode`/`version` actions and keep publishing non-cancelling. Define recovery for both partial uploads and post-upload tag/docs failures. `select-mode` is not a complete recovery system: pending changesets take priority, and it may return `none` after every package uploaded even if tagging/deployment failed.

Crust provides a concrete example. [Run 35409248194][crust-failed] uploaded packages, then failed on `crust: command not found` while releasing create-crust. A later fix commit's [run 35413764415][crust-recovered] successfully published the remaining `create-crust@0.3.0` and deployed docs. Mitome's version-delta gate would not ordinarily select such a fix commit.

### 3. Keep the Bun-pack → npm-publish bridge

Installed CLI 3.0.1's `dist/getPublishPlan.mjs:553-565` and [tagged source][publish-tool] select npm/pnpm/Yarn adapters; Bun falls through to npm. Native `changeset pack` uses the same selection. [Bun documents][bun-catalogs] that its pack/publish commands resolve `catalog:` references, while this repository also relies on `workspace:` substitution.

Do not replace the existing bridge with plain `changeset publish` merely to resemble the official example. This is an upstream packaging compatibility constraint; no new local monkey patch or package-manager migration is warranted.

Keep the small explicit publisher. A local invariant check confirmed its 15 manifests match the fixed group, share version 0.0.0, and are in dependency order. There is no current package-order bug requiring Crust's generic graph sorter.

### 4. Medium: harden preparation, registry checks, and recovery

The current `npm view ... >/dev/null 2>&1` treats every registry failure as an absent version. Distinguish a genuine missing version from network/auth/registry errors and fail closed on the latter. Assert actual package versions against the intended cohort; use manifest versions for lookups.

Build, pack, and validate all artifacts before uploading any. Pass those artifacts from a read-only job to the OIDC publisher, and publish the checked tarballs rather than repacking. This follows official permission-separation guidance; both repositories currently execute builds inside the OIDC-authorized job.

If adopting `changesets/action/publish`, honor its v2 `CHANGESETS_OUTPUT` protocol. A bare npm loop can upload successfully while the action reports `published: false` and creates no releases. Crust's `changeset git-tag` call supplies structured events after publishing. [Action implementation][action-run]

Mitome's single cohort tag is a valid project choice. Moving to Changesets-managed package tags/releases is a separate visible behavior change; keep the cohort convention initially unless a change is desired.

Crust is not a perfect retry template: its top-level script skips published workspace versions, but `publishStagedPackages` still unconditionally uploads each staged platform package. A failure midway through one CLI's platform set can therefore encounter immutable already-published versions on retry. Do not replace Mitome's per-platform skip behavior with that path. [Crust staged publisher][crust-staged]

### 5. Medium: test the installed CLI artifact

Mitome's release fixtures pack seven JS packages, deliberately omit optional dependencies, and check launcher links. They run before compilation of the eight platform packages. CLI tests use `dist/local/mitome`; they do not prove the installed npm launcher's platform selection works.

Keep existing publint/type/install checks. Add a packed Linux x64 install-and-launch smoke after release compilation, and verify every platform tarball contains its expected executable. Cross-compilation alone does not verify runtime compatibility on every target. [Fixtures][fixtures], [binary build][binary-build], [launcher][launcher]

### 6. Operational: verify npm trust and environment settings

All 15 package names returned HTTP 200 from npm with `latest: 0.0.0`; initial package-name bootstrap is not a current blocker. The inspected Node/npm versions meet the documented OIDC minimums (Node 22.14.0, npm 11.5.1).

However, npm trusted-publisher settings cannot be established from workflow YAML. Each package must authorize the exact repository and workflow filename, plus the environment if restricted. New configurations since September 3 default to staged publishing; direct `npm publish` needs permission. Changesets currently documents staged publishing as unsupported. [npm trusted publishing][npm-oidc], [Changesets automation][automation]

The GitHub environments API listed only `copilot`, not a configured `release` environment. The YAML's `environment: release` does not establish an approval gate.

Before running an automated release, obtain owner confirmation or redacted screenshots of each package's trusted publisher (including direct-publish permission), and decide whether `release` should require approval. No secret token is needed for this verification. GitHub OIDC publishing generates provenance automatically for public packages from public repositories; adding `--provenance` is not the missing fix.

## Proposed implementation scope

1. Reuse CI as a release prerequisite; settle release-PR check triggering.
2. Replace version-diff selection with official Changesets mode/version actions.
3. Separate checked Bun-packed artifacts from the OIDC uploader; retain the existing cohort tag convention.
4. Fail closed on registry errors, preserve per-package retries, and add packed CLI smoke coverage.
5. Add/document recovery for partial uploads and tag/docs failures; verify npm/environment settings before publishing.

Do not add a generic release framework, copy Crust's size-report jobs/runtime matrices, or upgrade dependencies without a separate reason. Preserve release-linked docs deployment unless a different docs cadence is requested.

Success criteria for implementation: failed CI blocks uploads; no-change runs are harmless; partial uploads resume without republishing existing versions; registry errors stop publication; all uploads use previously checked tarballs; installed CLI smoke passes; tag/docs recovery works after npm publication is complete.

## Verification and limitations

Performed: repository/source inspection, read-only GitHub workflow/PR/rules/environment queries, successful tool-version checks, a successful Node manifest/order assertion, and public registry queries for all 15 packages. The official-source brief was independently checked against installed source and current documentation.

Not performed: full lint/typecheck/tests, fresh tarball probes, cross-platform execution, actual publishing/deployment, or private npm publisher-policy inspection. These are investigation findings, not a tested replacement workflow. Only this research document was added; workflows were not changed.

## Sources

[mitome-release]: https://github.com/chenxin-yan/mitome/blob/bf6847a76a4c4e7509cc60f57301fb3935767727/.github/workflows/release.yml
[mitome-ci]: https://github.com/chenxin-yan/mitome/blob/bf6847a76a4c4e7509cc60f57301fb3935767727/.github/workflows/ci.yml
[crust-release]: https://github.com/chenxin-yan/crust/blob/23ef4e994f8a0c5f0cdcdad6cf5eea2699cb20f9/.github/workflows/release.yml
[crust-publisher]: https://github.com/chenxin-yan/crust/blob/23ef4e994f8a0c5f0cdcdad6cf5eea2699cb20f9/scripts/publish-packages.mjs
[crust-staged]: https://github.com/chenxin-yan/crust/blob/23ef4e994f8a0c5f0cdcdad6cf5eea2699cb20f9/packages/crust/src/commands/publish.ts
[automation]: https://changesets.dev/guide/automating
[action]: https://github.com/changesets/action/blob/v2.1.2/README.md
[action-run]: https://github.com/changesets/action/blob/v2.1.2/src/run.ts
[github-triggers]: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow
[release-pr]: https://github.com/chenxin-yan/mitome/pull/33
[mitome-run]: https://github.com/chenxin-yan/mitome/actions/runs/35400494663
[crust-failed]: https://github.com/chenxin-yan/crust/actions/runs/35409248194
[crust-recovered]: https://github.com/chenxin-yan/crust/actions/runs/35413764415
[publish-tool]: https://github.com/changesets/changesets/blob/%40changesets/cli%403.0.1/packages/cli/src/commands/publish/getPublishTool.ts
[bun-catalogs]: https://bun.com/docs/pm/catalogs#publishing
[fixtures]: https://github.com/chenxin-yan/mitome/blob/bf6847a76a4c4e7509cc60f57301fb3935767727/scripts/release-fixtures.ts
[binary-build]: https://github.com/chenxin-yan/mitome/blob/bf6847a76a4c4e7509cc60f57301fb3935767727/packages/cli/scripts/build-release.ts
[launcher]: https://github.com/chenxin-yan/mitome/blob/bf6847a76a4c4e7509cc60f57301fb3935767727/packages/cli/scripts/mitome.mjs
[npm-oidc]: https://docs.npmjs.com/trusted-publishers
