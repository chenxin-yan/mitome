# Upstream provenance

This directory vendors the rules of [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) that `@cloudflare/oxlint-config` does not carry. Upstream recommends that preset over anti-slop, and the preset carries anti-slop's other general rules under the plugin name `quality`, so only these remain here:

- `anti-slop`: `no-module-mocking`, `no-runtime-typeof`, `no-shape-in-symbol-names`, `no-unknown-parameters`, `require-safety-comment-for-type-assertion`, with the helpers they use (`shared/function-parameters.ts`, `shared/scope.ts`).
- `anti-slop-effect`: all five Effect rules, with `effect/shared/tagged-values.ts`.

- Merge base: `6d538555cb151d4121ed51a27db81890eacf8ae9`
- Adopted upstream revision: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`, upstream's last code revision.

To update a rule, three-way merge it from the adopted revision by hand, keeping the deviations below. Upstream's RuleTester suites are not vendored; run them in the upstream checkout (Node, not Bun: Oxlint 1.80's `RuleTester` rejects Bun). Rule enablement is repository policy in the `lint` block of the root `vite.config.ts` and requires owner approval.

## Intentional local deviations

- The rules import the plugin API from `vite-plus/lint/plugins`, the copy that ships with the Oxlint Vite+ runs, in place of `@oxlint/plugins`.
- `no-manual-tagged-construction` is disabled only for test files because matcher expectation objects such as `toMatchObject({ _tag: "Failure" })` are assertions, not domain construction. Other Effect rules remain enabled in tests.
- `no-module-mocking` also recognizes `vi` imported from `vite-plus/test`, which is where this repository's tests import it.
- The generic entry point registers only the rules listed above.
