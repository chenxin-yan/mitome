# Mitome

Mitome exists to let people define and run AI agents for their own use cases.

## Public interface

Users install `@mitome/sdk` with `@mitome/providers`. Promise-first APIs are imported from `@mitome/sdk`; Effect-native APIs are imported from `@mitome/sdk/effect`. `@mitome/core` is the published internal runtime engine, not a documented authoring surface.

The root SDK and its Effect subpath intentionally expose different `TurnEvent` shapes for their respective runtimes.

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

**Agent Definition**:
A user-authored declaration of exactly one Agent, its Providers, Default Model, and Plugins.
_Avoid_: Definition (bare), configuration, setup script, registry

**Agent Definition module**:
A TypeScript module whose default export is one Agent Definition.
_Avoid_: Agent Definition, entry file, setup script

**Agent Definition directory**:
A directory selected as a load target whose Agent Definition module is `index.ts`.
_Avoid_: Agent Definition, folder

**Plugin**:
A named, reusable extension included by an Agent Definition to add Tools, contribute Instructions, or participate in the Agent lifecycle.
_Avoid_: Toolkit, package, add-on

**Instructions**:
A static markdown fragment a Plugin contributes to an Agent's system prompt, composed in Plugin definition order at Session creation.
_Avoid_: System prompt (the composed whole), prompt fragment

**Model**:
A model available through a Provider that an Agent uses to generate Steps.
_Avoid_: Provider, LLM

**Model identifier**:
A Provider-qualified name, written as `provider/model`, that selects one Model.
_Avoid_: Model name, model key

**Model catalog**:
The known Model identifiers a Provider offers for discovery and selection; it is a set of hints, not an entitlement authority or a closed registry.
_Avoid_: Model registry, available Models

**Default Model**:
The Model an Agent uses for a Turn when its Host does not select another Model under a registered Provider.
_Avoid_: Primary Model, fallback Model

**Provider**:
A configured integration through which an Agent can access a family of Models from one external model service.
_Avoid_: Vendor, backend, Provider adapter

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
A user decision allowing one pending Tool call to execute; the Turn stays paused until the decision is resolved or the Turn is interrupted.
_Avoid_: Permission, confirmation

**Host**:
A program that drives Sessions on a user's behalf: starting Turns, presenting events, and resolving Approvals.
_Avoid_: Frontend, client, harness

**Credential**:
A stored secret that authorizes Mitome to use one Provider on behalf of the user.
_Avoid_: Token, key, login

**Auth capability**:
The module a Credential descriptor names; its `authenticate` export lets the Host run a Provider's interactive login or logout.
_Avoid_: Auth plugin, login module
