<!-- markdownlint-disable MD013 -->

# Release pipeline simplification

## TL;DR

- Keep the two-job design: an unprotected version-PR job and protected `release` publish job. A one-job `changesets/action` flow would either approve version-PR creation or lose the current release identity/retry guarantees.
- Make only low-risk deletions now: workflow-level permissions, dispatch retry inputs, publish checkout history, explicit Bun version, npm 11.19.0 install, and the docs build.
- Keep custom archive packing, ordered idempotent npm publishing, and the single `v<version>` tag/GitHub Release; Changesets cannot replace them without changing to per-package releases.
- Re-run the original workflow to recover a partial publish. Removing dispatch intentionally removes recovery after the original run is unavailable.
- No workflow file is changed by this report.

## Step-by-step verdict table

| Current item | Verdict | Replace with / rationale |
| --- | --- | --- |
| `push` on `main` | Keep | Normal version-PR and release trigger. |
| `workflow_dispatch` inputs | Delete | Re-run the original workflow/job; this deliberately drops manual recovery when that run is unavailable. |
| workflow-level `contents: read` | Delete | Both jobs declare their effective permissions. |
| concurrency | Keep | Prevents a race between `npm view` and `npm publish`. |
| `version-pr` job and its write permissions | Keep | It must create/update the version PR before release approval. |
| version-job checkout with `fetch-depth: 0` | Keep | The detector reads `github.event.before`'s package manifest. |
| `Detect a merged version change` | Keep | It is the reliable fixed-group version and exact-source gate; action outputs cannot replace it. |
| `mise-action` and frozen Bun install | Keep | Required to run the custom version command and Changesets. |
| `changesets/action` `version` command | Keep | Creates/updates the version PR. Do not configure its `publish` or GitHub releases. |
| `release-sha` job output / dispatch fallback | Delete | In a push-triggered run, use `${{ github.sha }}` directly in `publish`; re-runs retain it. |
| protected `publish` job, `contents: write`, `id-token: write` | Keep | Rename it `release` if desired; `environment: release` must remain job-level for OIDC and approval. |
| publish checkout `fetch-depth: 0` | Delete | Default checkout of `${{ github.sha }}` is enough to build, pack, and tag `HEAD`. |
| `setup-bun` `bun-version: 1.3.14` | Delete | Let `packageManager: bun@1.3.14` remain the Bun authority. |
| `setup-node` 24.18.0 | Keep | `node`/`npm` are needed for manifest checks and OIDC publish. |
| immutable-source verification | Keep | Bind checkout SHA and fixed-group version before publication. |
| frozen Bun install | Keep | Build, fixtures, and packing use the workspace install. |
| `bun run build` | Replace | `bun run build:pkgs`; docs are not publish artifacts. |
| release fixtures and CLI `build:release` | Keep | Validate packed consumers and build all platform binaries. |
| global `npm@11.19.0` install | Delete | Node 24.18.0 bundles npm 11.16.0, above npm OIDC's 11.5.1 minimum. |
| Bun archive packing + LICENSE copy | Keep | Bun resolves `catalog:`/`workspace:` before the npm upload; ignored per-package LICENSE files must be supplied. |
| ordered `npm view` / `npm publish` loop | Keep | It is the partial-publish recovery mechanism; retain the explicit package list. |
| create/verify `v<version>` tag | Keep | Preserves the single release identity and verifies retries target the same source. |
| create-if-missing GitHub Release | Keep | Preserves one tagged release and retry idempotency. |

## Recommended simplified pipeline

**Shape.** Retain two jobs and `push(main)`. `version-pr` remains ungated, detects a version-manifest change, and invokes Changesets only to maintain the version PR. `release` is conditional on the detector output, runs in the protected `release` environment, checks out `github.sha`, verifies it, builds package artifacts and CLI binaries, Bun-packs archives, publishes idempotently with npm OIDC, then creates/verifies one `v<version>` tag and release.

The detector is intentionally retained: on a later unrelated no-changeset push, `changesets/action` cannot distinguish that push from a just-merged version PR. Routing a publish job from `hasChangesets: false` would attempt to release the unrelated SHA and fail the single-tag source check.

```yaml
name: Release
on:
  push:
    branches: [main]

concurrency: ${{ github.workflow }}-${{ github.ref }}

jobs:
  version-pr:
    runs-on: ubuntu-latest
    permissions: { contents: write, pull-requests: write }
    outputs:
      release-version: ${{ steps.release.outputs.version }}
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 }
      - id: release
        name: Detect a merged version change
        run: | # retain the current packages/core manifest comparison
          ...
      - uses: jdx/mise-action@v4
      - run: bun install --frozen-lockfile
      - uses: changesets/action@v1
        with:
          version: bun run version-packages
          commit: "chore(release): version packages"
          title: "chore(release): version packages"

  release:
    needs: version-pr
    if: needs.version-pr.outputs.release-version != ''
    runs-on: ubuntu-24.04
    environment: release
    permissions: { contents: write, id-token: write }
    env:
      RELEASE_SHA: ${{ github.sha }}
      RELEASE_TAG: v${{ needs.version-pr.outputs.release-version }}
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.sha }}
      - uses: oven-sh/setup-bun@v2
      - uses: actions/setup-node@v7
        with: { node-version: 24.18.0 }
      - run: ./scripts/verify-release-source.sh # or retain inline check
      - run: bun install --frozen-lockfile
      - run: bun run build:pkgs
      - run: bun run test:release
      - run: bun run --cwd packages/cli build:release
      - run: ./scripts/publish-release.sh # retain current pack/publish/tag/release logic
```

`verify-release-source.sh` and `publish-release.sh` above are labels for the existing inline shell, not a recommendation to extract scripts. Keep it inline unless extraction makes the shell independently testable; that is not required for this simplification.

## Workarounds and their upstream status

| Workaround | Upstream repo | Issue link + status | Drop today? |
| --- | --- | --- | --- |
| Bun-pack tarballs, then npm-publish them | Changesets | [#1789](https://github.com/changesets/changesets/issues/1789), [#2181](https://github.com/changesets/changesets/issues/2181) — open | No. |
| npm, not Bun, performs OIDC trusted publishing | Bun | [#22423](https://github.com/oven-sh/bun/issues/22423) — open; [#29374](https://github.com/oven-sh/bun/pull/29374) — closed/unmerged | No. |
| npm, not Bun, supplies provenance | Bun | [#15601](https://github.com/oven-sh/bun/issues/15601), [#30522](https://github.com/oven-sh/bun/issues/30522) — open | No. |
| Manual catalog-aware archive path | Bun / Changesets | No dedicated Bun-catalog/Changesets issue found — **candidate to file** | No. |
| Manifest-diff detector and SHA/version relay | changesets/action | No issue found for pre-publish fixed-group version + source-SHA output — **candidate to file** | No, not with a single immutable `v<version>` release. |
| `npm view` before each publish | npm CLI | No transaction/resume issue found — **candidate to file** | No; published versions are immutable. |
| Manual single tag and GitHub Release | Changesets | No issue: action intentionally uses per-package tags/releases | No while one `v<version>` release is required. |

## Sources

- <https://github.com/changesets/action/blob/a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d/src/index.ts#L54-L165>
- <https://github.com/changesets/action/blob/a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d/src/run.ts#L97-L165>
- <https://github.com/changesets/action/blob/a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d/action.yml#L31-L62>
- <https://github.com/changesets/action/blob/a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d/README.md#custom-publishing>
- <https://github.com/changesets/changesets/blob/a897bb8ac115fa65343a8bfe53654040c1542a80/docs/fixed-packages.md>
- <https://github.com/changesets/changesets/blob/a897bb8ac115fa65343a8bfe53654040c1542a80/packages/cli/src/commands/tag/index.ts#L8-L35>
- <https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#jobsjob_idenvironment>
- <https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#how-permissions-are-calculated-for-a-workflow-job>
- <https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs>
- <https://github.com/actions/checkout/blob/main/README.md#fetch-all-history-for-all-tags-and-branches>
- <https://github.com/oven-sh/setup-bun/blob/main/README.md#usage>
- <https://github.com/nodejs/node/blob/v24.18.0/deps/npm/package.json#L1-L4>
- <https://docs.npmjs.com/trusted-publishers>
- <https://bun.com/docs/pm/catalogs#publishing>
- <https://docs.npmjs.com/cli/v11/commands/npm-publish#description>
- <https://cli.github.com/manual/gh_release_create>
- <https://github.com/changesets/changesets/issues/1789>
- <https://github.com/changesets/changesets/issues/2181>
- <https://github.com/oven-sh/bun/issues/22423>
- <https://github.com/oven-sh/bun/pull/29374>
- <https://github.com/oven-sh/bun/issues/15601>
- <https://github.com/oven-sh/bun/issues/30522>
