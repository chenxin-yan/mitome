---
"@mitome/core": patch
"@mitome/sdk": patch
"@mitome/cli": patch
---

Post-tool hooks now run for failed Tool handler results (previously skipped when a result validator existed or for dynamic schema-less failures); the success-result validator still only sees successful outputs. The SDK plugin `setup` signature drops its `signal` parameter, which could never fire because resource acquisition is uninterruptible. CLI `install`/`runHost` return exit codes instead of mutating `process.exitCode` mid-flight. create-mitome keeps its `>=24.2` Node floor, which `import.meta.main` requires.
