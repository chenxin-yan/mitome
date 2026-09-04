---
"@mitome/core": patch
"@mitome/sdk": patch
---

Tool input validation failures return an `execution-denied` result to the Model before `preTool`, approval, or the handler runs, with reason `Tool input validation failed: <issues>`. The Turn continues; validator defects instead fail it with `TurnError`.
