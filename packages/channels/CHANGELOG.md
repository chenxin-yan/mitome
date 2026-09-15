# @mitome/channels

## 0.1.0

### Minor Changes

- 4f64bd2: Add `@mitome/channels/http`. Its `http()` Host streams turns from `POST /conversations/:id/turns` as Server-Sent Events in `{ v: 1, turnId, event }` frames. Built-in bearer authentication isolates routes by principal, overlapping turns return `409`, and disconnecting cancels the turn.

  Approvals are denied by default. Set `approvals: "interactive"` to answer them through `POST /turns/:turnId/approvals/:approvalId`; requests require the same authenticated principal and time out after five minutes by default.

### Patch Changes

- Updated dependencies [8f26dc1]
- Updated dependencies [88ea7c0]
- Updated dependencies [9c47617]
- Updated dependencies [599c0fe]
- Updated dependencies [4e45a1f]
- Updated dependencies [bda85a3]
- Updated dependencies [eb4d90c]
- Updated dependencies [19ae752]
- Updated dependencies [ac80885]
  - @mitome/core@0.1.0
