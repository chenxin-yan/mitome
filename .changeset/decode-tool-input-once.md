---
"@mitome/core": patch
"@mitome/sdk": patch
---

Tool input is decoded once per Tool Call, during preparation. Hooks (`preTool` and `postTool`), the approval predicate, `approval-required` events, and the handler all receive that one decoded value; the SDK handler no longer runs the input schema a second time, and `postTool` sees decoded rather than raw params. A direct `toolkit.handle` call without a Tool Call id now goes through the same preparation instead of executing raw params.
