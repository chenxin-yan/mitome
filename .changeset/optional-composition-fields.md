---
"@mitome/core": minor
"@mitome/sdk": minor
---

Agent `extensions` and SDK Extension `tools` are now optional and default to empty arrays. `withSession` is now callback-last: use `withSession(agent, options, use)` or `withSession(agent, use)`.
