---
"@mitome/cli": patch
"@mitome/sdk": patch
---

Fail loud instead of hanging or collapsing errors: `mitome auth login` now detects piped stdin without silently hanging on an open, silent pipe; the auth host distinguishes missing/non-OAuth providers, broken capability modules, and protocol violations; SDK schema validation reports every issue with its path; and rejected approval predicates are logged before denying.
