---
status: accepted
---

# Separate history, Compaction, and execution recovery

Mitome will support embedded applications and a local coding Agent with built-in durability, rather than make each Host implement recovery. Turn-only persistence loses too much unfinished work; Step-only persistence cannot distinguish an interrupted Tool from an external operation that completed before its result was recorded. Preserve completed-Step progress and Tool intent/outcomes separately from completed-Turn conversational commits. This is an accepted direction, not an implemented guarantee; storage, schemas, and public APIs still require design. Delivery is tracked in [roadmap #174](https://github.com/chenxin-yan/mitome/issues/174), with the shared persistence contract in [#170](https://github.com/chenxin-yan/mitome/issues/170).

## Recovery contract

The first durable runtime has one coordinating process and supports restart recovery, not concurrent distributed workers. Recover safe work automatically, reuse recorded Tool outcomes, and retry unknown outcomes only under explicit replay safety and application/upstream idempotency. An unknown unsafe outcome pauses for reconciliation. Approval authorizes execution; it does not make replay safe or guarantee exactly-once external effects.

Accepted work outlives its client connection. Disconnect detaches observation; explicit cancellation stops further execution cooperatively and cannot undo completed effects. Pending Approvals and cancellation decisions survive restart. The persistence contract must cover accepted-work identity and duplicate delivery, progress/result retrieval, and bounded recovery attempts. Embedded applications may still opt out of durable storage; persistence remains explicitly composed rather than inferred by a Host.

## History contract

A History tree preserves Message ancestry and alternate Branches. Selecting an earlier user Message positions a new continuation before it and restores its text for editing; selecting another Message continues after it only where the resulting Model Prompt is structurally valid. Branch selection reconstructs context, never executes historical Tools. Workspace files and external effects remain unchanged.

Browsing is allowed during a Turn, but switching the execution Branch waits for completion or explicit cancellation. There is one active Turn per Session. Optional Branch summaries carry information from an abandoned Branch into the new one only on explicit request; they are off by default. Compaction alone never imports another Branch's future.

## Distinct responsibilities

- The History tree owns ancestry and selected-path semantics. The Transcript remains the committed conversational record; whether it encodes a tree or a selected path is an open representation decision.
- A Checkpoint is Compaction state, not an execution recovery record. It applies only to compatible ancestry. Preserve all Messages and derive the Model Prompt from the selected Branch and its applicable Checkpoint.
- Execution state preserves unfinished work, Tool outcomes, Approvals, and cancellation independently of Transcript commits. Recovery must restore any staged Compaction state used by that work without publishing it as a completed Turn.
- Delivery state lets a client retrieve accepted work and its results after reconnecting. A replayable client stream, if provided, is not itself authority to rerun effects.

These responsibilities need not use separate databases or packages. Choose physical storage and APIs in the persistence design, including stable identities, branch-valid boundaries, summary provenance, crash-consistent writes, and recovery when Agent Definitions or Tool implementations change. Keep `Step` as one model generation; keep `Checkpoint` reserved for Compaction.

This revises ADR-0036's exclusion of mid-Turn recovery and Approval restoration, while retaining the distinction between committed history and unfinished execution. It retains ADR-0040's explicit composition rule and amends ADR-0055's linear Checkpoint assumption. The current process-bound SDK and HTTP disconnect behavior remain the implemented contracts until their replacement is delivered.

## Evidence

Pi v0.85.1 uses parent-linked entries and a selected leaf for ordinary coding Session navigation; its context projection picks Compaction from that path. This supports the history design, not a claim that its ordinary SessionManager recovers in-flight execution. See the pinned [navigation](https://github.com/earendil-works/pi-mono/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L3236-L3286) and [context projection](https://github.com/earendil-works/pi-mono/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/session-manager.ts#L334-L469) implementations. Mitome requires valid branch boundaries rather than adopting implicit synthetic Tool-result repair.
