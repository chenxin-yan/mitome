# @mitome/tui

The terminal behind `mitome tui`, built on OpenTUI core. It is a private workspace package bundled into the CLI binary, not published.

`runTerminal(application, renderer?)` presents one already acquired application and its one Session: it maps submitted text through the application's `parseInput`, runs one Turn at a time, shows `renderResult` output, rereads pending Approvals passively and decides them only from the focused Approval box. It loads no application module and owns no execution: submissions are forked into the caller's Scope, closing restores the terminal without waiting for Turn cleanup, and the caller shuts the application down. Requires Bun. See the [CLI guide](https://mitome.sh/docs/cli#tui).
