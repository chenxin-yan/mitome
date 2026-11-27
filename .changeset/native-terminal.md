---
"@mitome/cli": minor
---

Bare `mitome` opens the terminal for the selected Configuration (`--config`, else the default) with the same `--provider`, `--model` and `--grace` flags as `mitome run`. It acquires the Configuration once, keeps one Session and runs each submission through the Configuration's `text.parse`, one Turn and `text.render`, showing the rendered result as output and each Turn's outcome from the Session's own record. `mitome --continue` and `--continue=<id>` continue a conversation as `mitome run` does. When the Configuration keeps history the terminal names the conversation, says which one it continued, and on closing prints how to continue it; a Turn that failed or was interrupted says how many Entries it kept. Esc interrupts the running submission; Ctrl-C, SIGINT and SIGTERM restore the terminal before shutting down within the grace. Without a terminal on stdin and stdout it refuses and points to `mitome run`.

The terminal answers Approvals: it provides an `Approver` around each Turn that shows the pending Tool Call (its Turn, Tool-call id, Tool and parameters, shown as the indented JSON the Model sent, with control characters escaped) and waits for `y` to allow or `n` to deny it, with the Approval box focused (Tab). A decision after the Turn ended changes nothing.

Each platform package includes `LICENSE-FFMPEG` and `FFMPEG-SOURCE.md`, because the binary embeds OpenTUI's native library, which statically links FFmpeg under the LGPL, and that library's other notices in `third-party/opentui/`, and is licensed `MIT AND LGPL-2.1-or-later`.
