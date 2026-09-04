---
"@mitome/core": patch
"@mitome/sdk": patch
"@mitome/tui": patch
---

End Hooks now run in reverse Agent Definition order, and a failed Transcript save leaves the Turn out of in-memory history as well as the store.
