---
"@mitome/providers": patch
---

Codex authentication now reuses valid stored credentials and avoids redundant refreshes when several processes run at once or another process rotates a credential after a `401` response.
