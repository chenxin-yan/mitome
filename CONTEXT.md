# Mitome

Mitome exists to let people define and run AI agents for their own use cases.

## Language

**Agent**:
A user-defined AI participant that pursues a use case through a session.
_Avoid_: Bot, assistant

**Session**:
An interaction in which a user and an Agent exchange messages.
_Avoid_: Chat, conversation

**Turn**:
The work triggered by one user message and completed by one final Agent response.
_Avoid_: Request

**Step**:
One model generation within a Turn; a Turn may require multiple Steps to resolve Tool calls.
_Avoid_: Turn, iteration

**Definition**:
A user-authored declaration of exactly one Agent and its Plugins.
_Avoid_: Configuration, setup script, registry

**Plugin**:
A named, reusable extension included by a Definition to add Tools or participate in the Agent lifecycle.
_Avoid_: Toolkit, package, add-on

**Model**:
The opaque provider-provisioned value a Definition names to generate Steps.
_Avoid_: Provider, LLM

**Toolkit**:
A collection of configured Tools that a Plugin may contribute.
_Avoid_: Plugin

**Hook**:
Plugin behavior attached to a named point in the Agent lifecycle, with an explicit contract to observe, transform, or veto.
_Avoid_: Middleware, event listener

**Tool**:
A named capability an Agent can invoke during a Session to inspect or affect something outside the model.
_Avoid_: Function, command

**Approval**:
A user decision allowing one pending Tool call to execute.
_Avoid_: Permission, confirmation

**Credential**:
A stored secret that authorizes Mitome to use one provider on behalf of the user.
_Avoid_: Token, key, login
