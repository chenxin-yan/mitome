# Mitome

Mitome lets people define and run AI Agents for their own use cases. This glossary describes the accepted domain; the [library plan](docs/plans/effect-native-library.md) distinguishes target behavior from current implementation.

## Language

**Agent**:
A user-defined AI participant pursuing a use case through a Session.
_Avoid_: Bot, assistant

**Agent program**:
The author-supplied behavior of an Agent, invoked to perform a Turn and return an application result independently of its conversational Messages.
_Avoid_: Agent Definition, mandatory agent wrapper

**Delegation**:
Explicitly starting another Agent program in its own child Session, distinct from a nested function call sharing the current Session. The caller may await its result or continue with a background-work handle; ownership determines its lifetime.
_Avoid_: Function call, automatic fork, subprocess

**Session**:
A live interaction owning shared conversational state across Agent invocations, with at most one active Turn.
_Avoid_: Chat, conversation

**Turn**:
One managed Agent program invocation, potentially containing several Steps, whose identity survives supported recovery and whose staged conversation commits once after successful completion and durable save when persistence is enabled. Failure does not commit partial conversation or undo completed external effects.
_Avoid_: Request, Step

**Step**:
One Model generation within a Turn.
_Avoid_: Turn, iteration

**Steering**:
Conversation input offered to an active Turn for a subsequent Model request, distinct from replacing the Agent program's invocation input or cancelling execution.
_Avoid_: Follow-up, Approval, cancellation

**Follow-up**:
Work explicitly queued for a separate Turn after preceding work, with its own application input and outcome.
_Avoid_: Steering, implicit retry, another Step

**Message**:
One user, Agent, or Tool contribution to a Session.
_Avoid_: Prompt, request

**Instructions**:
Ordered static text guiding an Agent, distinct from ephemeral per-Step changes to its Model Prompt.
_Avoid_: System prompt (the composed whole), prompt fragment

**Skill**:
A reusable package of task instructions and optional resources, explicitly made available to an Agent. Its content guides behavior but does not grant Tool authority or automatically execute code.
_Avoid_: Tool, Extension, permission grant

**Model Prompt**:
The ordered Messages supplied to a Model for one Step, derived from Instructions, the selected Branch's history and applicable Checkpoint, and staged Turn Messages.
_Avoid_: User Message, input (bare)

**Transcript**:
The durable owner of a committed History tree, its associated Checkpoints and one shared Execution position, which may outlive a Session and seed new Sessions; a selected Branch's linear conversation is a projection.
_Avoid_: Session, history (bare), execution log

**History tree**:
The ancestry of Messages preserving alternate continuations as Branches.
_Avoid_: Transcript, execution log

**Branch**:
One path through a History tree, continuing shared earlier Messages without isolating workspace files or external effects.
_Avoid_: Session, fork (the operation), workspace

**Execution position**:
The selected valid point in a Transcript's History tree from which the next Turn proceeds, shared by its Sessions and Routes and distinct from a viewer's browsing position.
_Avoid_: Session-local Branch, browsing cursor, execution status

**Branch summary**:
Information explicitly carried from an abandoned Branch into a new continuation.
_Avoid_: Checkpoint, Compaction, recovery record

**Compaction**:
Replacing a prefix of Messages with a summary in the Model Prompt while preserving canonical Messages.
_Avoid_: Summarization (the act), truncation, context pruning

**Checkpoint**:
The summary and retained boundary a Compaction produces for compatible Branch ancestry; staged Checkpoints are distinct from committed ones.
_Avoid_: Execution snapshot, Compaction entry, summary (bare)

**Execution state**:
The recoverable state of unfinished work, including Step progress, Tool intent/outcomes, pending Approvals and cancellation decisions, separate from committed conversation.
_Avoid_: Transcript, Checkpoint, Resource

**Tool**:
A named capability explicitly exposed to a Model for inspecting or affecting something outside the Model; merely providing an implementation service does not expose a Tool.
_Avoid_: Function, command, service

**Tool Call**:
One Model-requested invocation of a Tool within a Step, subject to author policy and any required Approval before execution.
_Avoid_: Function call, invocation (bare)

**Approval**:
An authorized decision permitting a pending Tool Call after policy checks; it is distinct from replay safety and cannot authorize a second execution merely by being repeated.
_Avoid_: Permission, confirmation, replay guarantee

**Provider capability grant**:
An explicit bounded authorization for a Provider-executed Tool capability before a Model request, distinct from approving one Tool Call's exact arguments or permitting replay.
_Avoid_: Approval, Session grant, blanket permission

**Host**:
An optional integration connecting an Agent to people or applications through a surface, with responsibility for interaction and consent presentation rather than Agent behavior.
_Avoid_: Extension, Frontend, client, harness

**Channel**:
A Host connecting an external surface, including HTTP or a messaging service, to the Agent.
_Avoid_: Interactive Host, Agent

**Route**:
The authorized mapping from a Channel's external conversation to its selected persisted history.
_Avoid_: Thread, Session, binding

**Principal**:
The authenticated identity a Channel request acts as, owning its work and control decisions; a conversation, Turn or Approval id alone is not authority.
_Avoid_: User (bare), token, client id

**Provider**:
A configured integration through which an Agent accesses a family of Models, with discovery and authentication information available independently of a live Session.
_Avoid_: Vendor, backend, Provider adapter

**Model**:
A model available through a Provider that an Agent uses to generate Steps.
_Avoid_: Provider, LLM

**Qualified Model id**:
A Provider-qualified identity written as `provider/model`, consisting of a Provider id and a Provider-native Model id.
_Avoid_: Model name, model key

**Model catalog**:
Known Provider-native Model ids offered as discovery hints, not an entitlement authority or closed registry.
_Avoid_: Model registry, available Models

**Default Model**:
The configured Model selected when an invocation does not explicitly select another.
_Avoid_: Primary Model, fallback Model

**Credential**:
A stored secret authorizing use of one Provider on behalf of the user.
_Avoid_: Token, key, login

## Current source vocabulary

These terms describe machinery still present in source, not requirements for the accepted redesign.

**Agent Definition**:
The current declaration grouping an Agent's Providers, Default Model and Extensions.
_Avoid_: Agent program, Definition (bare)

**Mitome Definition**:
The current composition pairing an Agent Definition, Hosts and optional Transcript persistence; the future optional Host composition contract is not yet specified.
_Avoid_: Agent Definition, Agent program

**Mitome Definition module**:
The currently selected executable module supplying one Mitome Definition.
_Avoid_: Implicit project configuration, sandbox

**Mitome Definition directory**:
The selected directory containing a Mitome Definition module.
_Avoid_: Implicit project root

**Extension**:
The current reusable unit contributing Tools, Instructions and lifecycle behavior, not mandatory target agent packaging.
_Avoid_: Plugin, Toolkit

**Hook**:
A current Extension's named lifecycle behavior to observe, transform, veto or propose.
_Avoid_: Required target protocol, event listener

**Resource**:
The current Extension-private services held for its Session lifetime, not a prohibition on shared infrastructure in the target.
_Avoid_: Execution state, universal dependency policy

**Session grant**:
A current Host-local convenience decision for later Tool-origin asks during one live Session, never an override of author policy or predicate failure.
_Avoid_: Auto-approve, durable authority

**Runner**:
The CLI subprocess loading the selected composition and running Hosts or one-shot output; current code also calls it the Child Host.
_Avoid_: Worker, Agent

**Child Host**:
The current CLI capability delegating execution, dependency installation or Provider authentication to a subprocess.
_Avoid_: Subagent, Agent

**Prompter**:
The current CLI capability for interactive terminal input during setup and authentication.
_Avoid_: Agent, Host

**Auth capability**:
The current Provider-owned login/logout entry used by credential bootstrap.
_Avoid_: Auth plugin, Session
