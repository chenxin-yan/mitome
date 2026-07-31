# Mitome

Mitome exists to let people define and run AI agents for their own use cases.

## Public interface

Users install `@mitome/sdk` and `@mitome/providers`; first-party Extensions ship at `@mitome/sdk/extensions`. Promise-first APIs come from `@mitome/sdk`, while Effect-native APIs come from `@mitome/sdk/effect`. [ADR-0022](docs/adr/0022-publish-the-sdk-as-the-sole-documented-surface.md) defines the public surface. Core errors are public Schema-tagged errors, provider errors are internal `Data.TaggedError` values widened at the boundary, and the CLI uses a plain app-level error.

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
A user-authored declaration of exactly one Agent, its Providers, Default Model, and Extensions.
_Avoid_: Definition (bare), configuration, setup script, registry

**Agent Definition module**:
A TypeScript module whose default export is one Agent Definition.
_Avoid_: Agent Definition, entry file, setup script

**Agent Definition directory**:
A directory selected as a load target whose Agent Definition module is `index.ts`.
_Avoid_: Agent Definition, folder

**Extension**:
A named, reusable unit included by an Agent Definition to add Tools, contribute Instructions, or participate in the Agent lifecycle.
_Avoid_: Plugin, Toolkit, package, add-on

**Instructions**:
A static markdown fragment an Extension contributes to an Agent's system prompt, composed in Extension definition order at Session creation.
_Avoid_: System prompt (the composed whole), prompt fragment

**Model**:
A model available through a Provider that an Agent uses to generate Steps.
_Avoid_: Provider, LLM

**Qualified Model id**:
A Provider-qualified id, written as `provider/model`, that selects one Model. Its two parts are a Provider id and a Provider-native Model id.
_Avoid_: Model identifier, Model name, model key

**Model catalog**:
The known Provider-native Model ids a Provider offers for discovery and selection, unqualified and without a Provider prefix; it is a set of hints, not an entitlement authority or a closed registry.
_Avoid_: Model registry, available Models

**Default Model**:
The Model an Agent uses for a Turn when its Host does not select another Model under a registered Provider.
_Avoid_: Primary Model, fallback Model

**Provider**:
A configured integration through which an Agent can access a family of Models from one external model service.
_Avoid_: Vendor, backend, Provider adapter

**Toolkit**:
A collection of configured Tools that an Extension may contribute.
_Avoid_: Extension

**Hook**:
Extension behavior attached to a named point in the Agent lifecycle, with an explicit contract to observe, transform, or veto.
_Avoid_: Middleware, event listener

**Tool**:
A named capability an Agent can invoke during a Session to inspect or affect something outside the model.
_Avoid_: Function, command

**Resource**:
The private set of services an Extension acquires at Session creation, holds for the Session's lifetime, and releases at Session end; visible only to that Extension's own Hooks and Tool handlers.
_Avoid_: Dependency, state, shared context

**Tool Call**:
One Agent invocation of a Tool within a Step, gated by Approval before it may execute.
_Avoid_: Function call, invocation (bare)

**Approval**:
A user decision allowing one pending Tool call to execute; the Turn stays paused until the decision is resolved or the Turn is interrupted.
_Avoid_: Permission, confirmation

**Host**:
A program that drives Sessions on a user's behalf: starting Turns, presenting events, and resolving Approvals.
_Avoid_: Frontend, client, harness

**Child Host**:
The CLI's capability for delegating Host work — running a Turn, installing Agent Definition dependencies, or Provider authentication — to a separate Host process.
_Avoid_: Spawner, process manager, subprocess (bare)

**Prompter**:
The CLI's capability for interactive terminal input — asking the user questions during init and auth flows.
_Avoid_: Readline, stdin (bare), input handler

**Credential**:
A stored secret that authorizes Mitome to use one Provider on behalf of the user.
_Avoid_: Token, key, login

**Auth capability**:
The module a Credential descriptor names; its `authenticate` export lets the Host run a Provider's interactive login or logout.
_Avoid_: Auth plugin, login module
