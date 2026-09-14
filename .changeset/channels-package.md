---
"@mitome/channels": minor
---

Add `@mitome/channels`, the package that will ship first-party Channel Hosts on per-Channel subpaths. It joins the fixed release group with no public import path yet; the first module is the shared Route lock that runs one Turn at a time per Route and fails an overlapping request with `RouteBusyError` for the Channel to answer on its surface.
