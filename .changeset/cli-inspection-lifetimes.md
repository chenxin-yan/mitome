---
"@mitome/cli": patch
---

Add `mitome ext list`, which prints resolved Extension names and installed versions in Agent Definition order.

`mitome auth login` and `mitome auth logout` now exit after authentication even when a Definition leaves background work running, and report specific errors for unavailable OAuth Providers or invalid capability modules. Circular diagnostic causes print as `[circular cause]` instead of recursing.
