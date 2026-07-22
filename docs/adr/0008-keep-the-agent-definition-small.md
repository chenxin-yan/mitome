---
status: amended by ADR-0016 and ADR-0024
---

# Keep the Agent Definition small

An Agent Definition has exactly three fields: required text instructions, one Model (the opaque canonical value of ADR-0016), and an ordered list of Mitome Plugins. It has no Agent name, direct Toolkit or Layer fields, runtime callback, persistence, provider configuration, or Step-limit override.
