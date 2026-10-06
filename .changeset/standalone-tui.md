---
"@mitome/core": minor
"@mitome/cli": minor
---

Add the standalone terminal. `mitome tui --app <file>` acquires the application once, keeps one Session and runs each submission through the application's `cli.parseInput`, one Turn and `cli.renderResult`, showing the rendered result as application output and each Turn's outcome from the Session's own record. Esc interrupts the running submission; Ctrl-C, SIGINT and SIGTERM restore the terminal before shutting the application down within the existing `--grace`.

`@mitome/core` adds `makeApprovals`, a process-local Approval channel whose `consent` plugs into `step` and `loop`, and an optional `cli.approvals` that grants its pending requests to the terminal. Each request shows its Turn, Tool-call id, Tool and once-decoded parameters and is resolved only through its own one-use `decide`.
