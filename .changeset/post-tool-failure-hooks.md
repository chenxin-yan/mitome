---
"@mitome/core": patch
"@mitome/sdk": patch
---

Run `postTool` Hooks for failed handler results with `isFailure: true`. Hooks may transform expected failures, which are checked by the failure validator; handler defects remain opaque, and the success-result validator sees only successful outputs. The SDK Extension `setup` callback no longer receives an `AbortSignal`, since Resource acquisition is uninterruptible.
