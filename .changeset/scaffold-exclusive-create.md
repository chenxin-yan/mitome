---
"create-mitome": patch
---

`create-mitome` and `mitome init` now enforce "never overwrites existing files" at creation: every scaffold file is created exclusively, so a name occupied by a symlink (including a dangling one) or by a file that appears after the preflight is refused instead of written through.
