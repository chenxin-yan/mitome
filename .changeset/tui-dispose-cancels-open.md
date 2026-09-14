---
"@mitome/tui": patch
---

Disposing the TUI Host while a Session open is still pending now interrupts that open, so the Session scope it was acquiring is released instead of running on after exit. Escape and dispose share the same cancellation path and the same one-second bound.
