# @mitome/cli

## 0.1.0

### Minor Changes

- d47566c: Add explicit `defineMitome({ agent, hosts })` composition with optional `hosts` and at most one Host. In automatic mode, the CLI runs the declared Host when supported and otherwise falls back to one-shot output. Declare `tui()` from `@mitome/tui` to enable the interactive Host; installing the package alone does not activate it.

### Patch Changes

- cf3f3b8: Add `mitome ext list` to print resolved Extension names and installed package versions in Agent Definition order, using `(anonymous)` for unnamed Extensions and `unknown` when a version cannot be found.
- 9f37ce9: Report distinct CLI authentication errors for unavailable OAuth Providers, capability modules missing `authenticate`, and invalid authentication operations or configuration. SDK schema validation reports every issue with its available path. Failed `needsApproval` predicates log a warning and require approval rather than allowing the Tool to run automatically.
