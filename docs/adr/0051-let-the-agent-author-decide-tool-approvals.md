---
status: amended by ADR-0056 and ADR-0057
---

# Let the Agent author decide Tool Approvals

Approval authority is layered: Tool authors flag risk, reusable policy can tighten, the Agent author decides, and Hosts resolve permitted asks. For locally executed Tool Calls and remotely deferred per-call Approvals, decode input before policy, compute the decision once per prepared Tool call, and never rerun policy or change arguments after consent. Deny wins over ask, ask over allow; explicit author allow may override only the Tool author's default, never stricter policy. Denials are stable, sanitized Model-visible outcomes, not execution.

Fail closed: author-policy failure must not run the Tool or reveal the raw cause. A failed Tool-risk predicate cannot silently allow execution. Missing consent denies; distinguish Tool-origin, policy-origin and predicate-failure asks so convenience grants cannot approve policy/error asks. Native upstream Tool approval support is a protocol, not Mitome's authority or an authenticated human decision service. Arbitrary application code is not sandboxed by this policy.

For Provider-executed Tools whose arguments are not known before a Model request, permit an explicit bounded **Provider capability grant** before dispatch. This is not a per-call Approval: a local handler cannot authorize an action the Provider already performed. Stricter policy still wins. If it requires consent to exact arguments, require genuine provider-side deferral or reject before sending the request; capability grants cannot override it. Per-call-only support for every remote capability was rejected because it would make non-deferred built-ins unusable even when the author explicitly accepts bounded capability-level authority. A grant does not establish replay safety, exactly-once effects or permission to retry an uncertain request. Concrete grant bindings, enforceable limits and durable representation remain to specify.

[ADR-0057](0057-use-effect-native-functions-and-optional-host-composition.md) replaces Agent Definition fields, Extension veto Hooks, synchronous callbacks and event-bound decision methods with native controlled execution. Exact schemas, operations and composition are pending. Preserve authority, validation and one-time decisions, not obsolete Promise spellings.

[ADR-0056](0056-separate-history-compaction-and-execution-recovery.md) requires durable pending Approvals and cancellation, with ownership and stale/duplicate decision checks across restart. Passive progress/event records are not authority. Approval authorizes an operation, not replay: recovery safety/idempotency is a separate decision, and exactly-once external effects are not promised.
