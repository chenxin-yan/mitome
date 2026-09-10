# Upstream provenance

This directory vendors source from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop).

- Merge base: `6d538555cb151d4121ed51a27db81890eacf8ae9`
- Adopted upstream revision: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`

## Adopted changes

The update adopts the incoming generic and Effect rule implementations and their adjacent tests, including the array pipeline, reducer accumulator, readable spacing, Effect tag, and Effect match rules. It also adopts upstream's lexical scope and type-alias resolution, safety-comment ownership, known-value analysis, and borrowed static `.shape` member exemption. The readable-spacing implementation retains its source notice in `vendor/eslint-stylistic/`.

The generic and Effect entry points register every rule from the adopted revision under the existing `anti-slop` and `anti-slop-effect` plugin names. Rule enablement remains repository policy in `.oxlintrc.json` and requires owner approval.

## Intentional local deviations

- `no-runtime-typeof` rejects every runtime `typeof`, including undefined existence probes and checks inside type guards. It has no `allowInTypeGuards` option.
- `no-unknown-parameters` exempts only parameters named `cause`; type-predicate subjects remain rejected.
- `no-manual-tagged-construction` is disabled only for test files because matcher expectation objects such as `toMatchObject({ _tag: "Failure" })` are assertions, not domain construction. Other Effect rules remain enabled in tests.
- The dictionary helper explicitly falls back to `null` after safe-array analysis so it typechecks with this repository's `noUncheckedIndexedAccess` setting; runtime behavior is unchanged.

The previous local `shared/ast.ts`, Reflect rule factory, and renamed shape-rule export were dropped in favor of upstream's layout. All callers moved together, the registered rule names are unchanged, and no duplicate helper implementations remain.

## Tests

Run every adjacent rule suite from the repository root:

```sh
bun run test:anti-slop
```

The script uses Node 22 or newer because Oxlint 1.80's `RuleTester` does not support Bun.

The two policy-deviation suites were also run against an otherwise pristine copy of the incoming revision and failed as expected, then passed against this merged implementation.
