---
"@mitome/channels": minor
---

Add `@mitome/channels/http`. Its `http()` Host streams turns from `POST /conversations/:id/turns` as Server-Sent Events in `{ v: 1, turnId, event }` frames. Built-in bearer authentication isolates routes by principal, overlapping turns return `409`, and disconnecting cancels the turn.

Approvals are denied by default. Set `approvals: "interactive"` to answer them through `POST /turns/:turnId/approvals/:approvalId`; requests require the same authenticated principal and time out after five minutes by default.
