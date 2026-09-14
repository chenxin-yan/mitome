---
"@mitome/providers": patch
---

The Codex Credential store now owns freshness: every request asks it for a usable Credential, and it reuses the stored one while it is not expiring, exchanges the refresh token under the storage lock otherwise, and after a 401 reuses a Credential another process has already rotated instead of exchanging again. Transport keeps only the single retry after a 401.
