---
"@mitome/core": patch
"@mitome/sdk": patch
"@mitome/tui": patch
---

Run end Hooks (`sessionEnd`, `turnEnd`, `stepEnd`) in reverse Agent Definition order, including cleanup after interrupted or failed starts. Commit a Turn to `history()` and `transcript()` only after the configured Transcript save succeeds; a failed save leaves it out of both.
