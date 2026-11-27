# One-shot runs and Tool approvals in other harnesses

Question, asked of the first native implementation (closed unmerged): `mitome run` waited forever when a Tool Call needed consent and the application wired `makeApprovals`, because only `mitome tui` read that channel. What do other harnesses do when a non-interactive run reaches an action that needs a human decision?

Researched 2026-10-31 from source and first-party docs. Versions are the ones named per section. Nothing here was run against a live Model; behavior is read from source, tests in that source, and official docs.

## Summary

| Harness     | One-shot command       | Needs approval, nobody can answer                                                                     | Model told?                                                             | Run continues? | Exit                                                | Opt-in to approve                                                               |
| ----------- | ---------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------- | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| pi          | `pi -p`, `--mode json` | No built-in approvals. Extension dialogs resolve at once: `confirm` → `false`, `select` → `undefined` | Whatever the extension's `block.reason` says                            | Yes            | not checked                                         | none needed; the extension decides                                              |
| opencode    | `opencode run`         | Auto-reject, warning line printed                                                                     | Yes: "cannot ask the user for permission… Continue without this action" | Yes            | not checked                                         | `--auto`                                                                        |
| fx          | `fx ask`               | Prompts on stderr only with a TTY stdin; otherwise the run ends                                       | Call recorded as rejected, "Permission required"                        | No             | 1, `error: "NonInteractivePermissionRequired"`      | `--auto` (model review), `--full-access`, saved rules                           |
| Codex       | `codex exec`           | Approval policy forced to `never`; any approval request is rejected                                   | Yes: "Execution failures are immediately returned to the model"         | Yes            | not checked                                         | `--approve-for-me`, `--sandbox …`, `--dangerously-bypass-approvals-and-sandbox` |
| Claude Code | `claude -p`            | Denied unless a hook or prompt tool approves                                                          | Yes; with `--permission-prompts none` also told not to retry            | Yes            | not checked; denials listed in `permission_denials` | `--allowedTools`, `--permission-mode`, `--permission-prompt-tool`               |

No harness waits. Four of five deny the one call and let the Model continue; fx ends the run with a named error. "Not checked" means the effect of a denial alone on the exit status was not traced. Every one that has approvals also has an explicit opt-in to approve without a human.

## pi

Installed 1.5.2; source cross-checked at `badlogic/pi-mono` v0.85.1.

- Pi has no built-in approval step: "it does not ask for approval before every tool call" (`docs/security.md:3`). Permission gates are extensions.
- In print and JSON mode `ctx.hasUI` is `false` and "Extensions run but can't prompt" (`docs/extensions.md`, Mode Behavior table).
- The no-UI context resolves dialogs immediately and fail-closed: `select: async () => undefined`, `confirm: async () => false` (`packages/coding-agent/src/core/extensions/runner.ts:236-239` at v0.85.1; same in installed `dist/core/extensions/runner.js:132-135`).
- The shipped example blocks when there is no UI: `if (!ctx.hasUI) return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" }` (`examples/extensions/permission-gate.ts`).
- In RPC mode a dialog may carry a `timeout`; when it expires the agent side resolves the default (`confirm` → `false`) (`docs/rpc-extension-ui.md:10`, `docs/extensions.md` "Return values on timeout").

## opencode

`anomalyco/opencode` branch `dev` at `38bd73789a43`; older local clone at `85e278b72` for the change in behavior.

- Current: every `permission.asked` event of the run's session gets an automatic reply. Without `--auto` it prints `permission requested: <action> (<resources>); auto-rejecting` and replies `decision: "reject"` with the message "This non-interactive run cannot ask the user for permission, so the request was rejected. Continue without this action." (`packages/cli/src/run/noninteractive.ts:57-58, 97-111`). Permissions already pending when the run attaches are answered the same way (`:225-233`).
- A decline with feedback is a `CorrectedError`, which "intentionally stays typed so the leaf can turn it into ToolFailure and the model continues" (`packages/core/src/permission.ts:273-277`).
- Questions are cancelled the same way: "make reasonable assumptions and state them" (`noninteractive.ts:54-55`).
- Opt-in: `--auto`, "Auto-approve permissions that are not explicitly denied"; `--yolo` and `--dangerously-skip-permissions` remain as hidden flags (`packages/cli/src/commands/commands.ts:37-46`).
- Earlier (`85e278b72`, `packages/opencode/src/cli/cmd/run.ts:731-750`): the reject carried no message, and a plain reject stopped the loop unless `experimental.continue_loop_on_deny` was set (`packages/opencode/src/session/processor.ts:241, 966, 1031`). opencode moved from "deny and stop" to "deny, tell the Model, continue".

## fx

`vercel-labs/fx` at `14a2dbb`; docs at fx.sh.

- "`fx ask` can't wait for you." (https://fx.sh/docs/using-fx/fx-ask.md, "Retries and requests that need you").
- Prompts are allowed in terminal output modes, and with `--json`/`--quiet` only when `--prompt-permissions` is passed and stdin is a TTY (`src/core/cli/cli_ask.zig:2692-2701`). The real prompt returns `unavailable` when stdin is not a TTY (`:4273-4283`). Docs: "piped or redirected input cannot receive approval prompts".
- When no prompt is available, `fx ask` prints the blocked action, `reason=noninteractive_permission_prompt_unavailable` and a remedy to stderr, records the call as rejected with "Permission required", and fails with `NonInteractivePermissionRequired` (`:2562-2603`). The run ends with `exit_code = 1` and `error_code = "NonInteractivePermissionRequired"`, keeping the assistant output and Tool Call records so far (`:2036-2047`).
- The default mode is `auto`, where a held action "doesn't open a prompt or end the turn. fx tells the agent why, and the agent can try another way" (https://fx.sh/docs/configure-fx/permissions.md). So the hard stop applies to `ask` mode and to configured `ask` rules.
- Library boundary: "Your application validates input and authorizes each operation inside `execute()`. libfx orders the calls but grants nothing itself, and CLI permission prompts don't apply to libfx tools." (https://fx.sh/docs/lib/tools.md).

## Codex

`openai/codex` `main` at `b7056f3408`; installed `codex-cli 0.167.1`.

- `codex exec` overrides the approval policy: "Default to never ask for approvals in headless mode" → `approval_policy: Some(AskForApproval::Never)` (`codex-rs/exec/src/lib.rs:630-632`). `Never` means "Never ask for user approval. Execution failures are immediately returned to the model." (`codex-rs/utils/cli/src/approval_mode_cli_arg.rs:13-15`).
- Any approval request that still arrives is rejected with a reason such as "command execution approval is not supported in exec mode" (`codex-rs/exec/src/lib.rs:2255-2338`).
- Safety comes from the sandbox instead: "By default, `codex exec` runs in a read-only sandbox"; `--approve-for-me` routes approval requests through automatic review (https://developers.openai.com/codex/noninteractive).

## Claude Code

Docs only: https://code.claude.com/docs/en/headless.

- "In a Manual mode `claude -p` run, a call that needs approval is denied unless something approves it, such as a `PermissionRequest` hook or a `--permission-prompt-tool`."
- The closest match to Mitome's bug: when a run has a permission host (an Agent SDK `canUseTool` callback or a prompt tool), "your run waits for that host to answer each permission request". `--permission-prompts none` or the `permissions.denyInsteadOfPrompting` setting turns that off: "Anything that would prompt is denied…, Claude is told that nobody can approve the request and not to retry it, and the run continues."
- With `--output-format stream-json`, denials appear as `permission_denied` messages and the final result lists them in `permission_denials`.

## What Mitome does

[ADR-0059](../adr/0059-let-the-host-answer-approvals.md) records the outcome: the Host that runs a Turn supplies who answers its Approvals, and with nobody present the call is denied and the Model is told.
