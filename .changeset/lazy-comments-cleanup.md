---
"@mitome/cli": patch
"@mitome/sdk": patch
"@mitome/core": patch
---

Report distinct CLI authentication errors for unavailable OAuth Providers, capability modules missing `authenticate`, and invalid authentication operations or configuration. SDK schema validation reports every issue with its available path. Failed `needsApproval` predicates log a warning and require approval rather than allowing the Tool to run automatically.
