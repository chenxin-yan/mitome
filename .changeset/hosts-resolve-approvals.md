---
"@mitome/core": minor
"@mitome/sdk": minor
"@mitome/tui": minor
"@mitome/cli": minor
---

Let the Agent author decide Tool Approvals, and make the built-in Hosts resolve them instead of auto-approving.

`defineAgent` accepts an optional `approvals` policy: `{ allow?, ask?, deny? }` lists of Tool-name patterns (exact name or prefix with one trailing `*`), or a synchronous `(call) => "allow" | "ask" | "deny" | undefined`. The most restrictive opinion wins: an Extension veto or Agent `deny` denies the call with a stable reason the Model sees, any `preTool` `"ask"` or Agent `ask` requires a Host Approval, `allow` runs the call without consulting the Tool's `needsApproval`, and otherwise the Tool author's default decides. Every `approval-required` event, live and persisted, carries `requirement: "tool" | "policy" | "predicate-error"`; a failed `needsApproval` predicate fails closed as `"predicate-error"`.

The TUI now prompts on `approval-required` with the Tool name, `requirement`, and decoded params: `y` approves, `n` denies with `Approval denied by the user.`, and for `requirement: "tool"` only, `a` allows that Tool for the rest of the Session. The Session grant is local to the running TUI, keyed by Tool name, cleared on `Ctrl-N` and on Transcript resume, and never answers `policy` or `predicate-error` asks.

One-shot output (`mitome -p`, or any non-TTY run) never waits: each Approval request is denied with a Model-visible reason and printed as `[approval <name> denied]`; the Turn continues and the exit status is unchanged. The new `mitome --yes` flag approves `requirement: "tool"` requests for that invocation only; `policy` and `predicate-error` requests are still denied. Scripts that relied on auto-approval of flagged Tools now pass `--yes` or set `approvals.allow` in the Agent (`allow` also skips the Tool's own predicate; `--yes` does not).
