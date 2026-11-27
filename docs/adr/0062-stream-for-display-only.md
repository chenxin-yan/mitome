---
status: accepted
---

# Stream for display only

Model output is shown as it arrives, but what is shown is never what is saved. A Step reads the Model's stream, publishes each part to viewers, folds the parts into the same complete response it used to wait for, and only then validates that response and runs its Tool Calls. What is committed is still decided by the Step, not by the stream: a Step commits when it completes ([ADR-0066](0066-keep-history-as-a-tree-of-steps.md)), and a Step cancelled while its response arrives saves nothing. Before this, a Step waited for the whole response and a viewer saw nothing while the Model wrote.

A viewer never slows or stops a Turn. Each viewer has a bounded buffer and loses partial events when it falls behind; the complete event that follows carries the full value, so the viewer is corrected. Complete events are bounded too. A full buffer drops its oldest undelivered event, never the newest, so the last event of a Turn (its outcome) always arrives; every event carries a sequence number, so the viewer sees the gap before it and re-reads the Session's history and Turn state instead of waiting for a repair that will not come. Anything shown before a complete event is provisional, and a Step that is retried withdraws what was shown for it. An Extension's event handler is not awaited and its errors are contained.

One small list of events serves Hosts and the Extensions that watch: partial text, reasoning and Tool input; Tool progress; and complete events for a Message, a Tool Call, a Tool result, a Step and the Turn's outcome.

Seven systems were surveyed (`docs/research/streaming-survey.md`). All separate partial events from one authoritative complete event. They differ where Mitome's rules already decide: several let a slow reader hold back the run (pi's protocol output, eve's stream writer, the Vercel AI SDK's chunk callback), one keeps partial text after a cancel (opencode), and one lets a failing hook fail the turn (eve).

## Consequences

Reconnecting to a run in progress is left to server Hosts and needs the durable store of [ADR-0056](0056-separate-history-compaction-and-execution-recovery.md); replaying partial events is not needed for a viewer in the same process. Events from a child in Delegation will be tagged with their parent and forwarded as complete Messages, not partial text. The Model Context shaping and event watching of [ADR-0058](0058-describe-an-agent-as-data-and-run-it-through-a-configuration.md) arrive with this work.

This is accepted and not yet implemented; it is the first work after the [MVP stack](../plans/mvp-plan.md).
