# Anthropic authentication: API key, OAuth, and what other agents do

Research date: 2026-11-22. Question: Mitome's Anthropic Provider authenticates with an API key only; should it also offer an OAuth sign-in, and which one?

Sources: pi 1.5.2 source installed on this machine and the `pi-mono` v0.85.1 checkout; the opencode checkout at `85e278b` (2026-06-14) and its git history; Anthropic's documentation and terms as fetched on the research date; the repositories and documentation of other agents; Mitome's stack tip on Effect 4.1.5. Web claims carry their URL. "Secondary" marks press or forum reports of a primary event that was not read directly.

## Short answer

"OAuth for Anthropic" names three different things:

|                                                  | Whose account                 | Billed to                                             | Anthropic's position for a third-party tool                                                                                   |
| ------------------------------------------------ | ----------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Claude subscription sign-in (claude.ai, Pro/Max) | A person's Claude plan        | The plan, or since April 2026 "extra usage" per token | Prohibited: third parties may not offer it                                                                                    |
| Console sign-in (`ant auth login`)               | A Claude Console organisation | The organisation, at API rates                        | Documented for "local development and scripting on your own machine"; nothing says a third-party tool may or may not embed it |
| Workload identity federation                     | A service account             | The organisation                                      | Documented, for CI and servers with an identity provider                                                                      |

pi does the first one. opencode and Crush did the first one and removed it in 2026 at Anthropic's request.

## Anthropic's rules

Claude Code documentation, "Legal and compliance", section "Authentication and credential use" (https://code.claude.com/docs/en/legal-and-compliance, fetched 2026-11-22):

> "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."

> "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."

> "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."

The same page allows two things: customers managing their own API keys, and "an end user ... signing in to the unmodified Claude Code binary with their own Claude subscription".

The Agent SDK overview repeats it (https://code.claude.com/docs/en/agent-sdk/overview): "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."

The Consumer Terms prohibit automated access "except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it" (https://www.anthropic.com/legal/consumer-terms).

### What happened in 2026

| Date       | Event                                                                                                                                                                                   | Evidence                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 2026-01-07 | Crush removes Claude subscription support "following a request from Anthropic, to align with their terms of service"                                                                    | https://github.com/charmbracelet/crush/pull/1783                                                       |
| 2026-01-08 | Anthropic blocks subscription tokens outside Claude Code server-side; users see "This credential is only authorized for use with Claude Code"                                           | Secondary: VentureBeat 2026-01-09                                                                      |
| 2026-03-19 | opencode merges "anthropic legal requests": removes its built-in `opencode-anthropic-auth` plugin and the Claude Code beta flag. Its docs now say "Anthropic explicitly prohibits this" | https://github.com/anomalyco/opencode/pull/18186                                                       |
| 2026-04-04 | Subscriptions stop covering third-party tools; such requests need "extra usage" and bill per token                                                                                      | Secondary: TechCrunch, The Verge; observed from pi in https://github.com/earendil-works/pi/issues/3372 |
| 2026-05-13 | Anthropic announces a separate monthly credit for the Agent SDK and third-party apps from June 15                                                                                       | Secondary: VentureBeat                                                                                 |
| 2026-06-15 | Anthropic pauses that change: "nothing has changed"                                                                                                                                     | https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan         |
| 2026-10-07 | Max, Ultra and Team plans gain monthly API credits, usable "with an API key from your linked Claude Console organization"                                                               | Same page                                                                                              |

The policy moved six times in ten months. The rule against third parties offering Claude.ai login did not move.

## How pi does it

pi 1.5.2, `@earendil-works/pi-ai` (`auth/oauth/anthropic.ts`, `providers/anthropic.ts`, `api/anthropic-messages.ts`).

- It supports an API key (`ANTHROPIC_API_KEY`), a bearer token (`ANTHROPIC_AUTH_TOKEN`), workload identity federation, and a browser sign-in for Claude Pro/Max.
- The sign-in reuses Claude Code's own OAuth client: the same client id, `https://claude.ai/oauth/authorize`, token endpoint `https://platform.claude.com/v1/oauth/token`, PKCE, a loopback callback on port 53692 or a pasted code. pi has no client registration of its own.
- When the credential is a subscription token (detected by the substring `sk-ant-oat`), pi changes the request to look like Claude Code: `Authorization: Bearer`, `anthropic-beta` with `claude-code-20250219` and `oauth-2025-04-20`, `user-agent: claude-cli/<version>`, `x-app: cli`, a first system block that reads "You are Claude Code, Anthropic's official CLI for Claude.", and Tool names mapped onto Claude Code's seventeen.
- Tokens are stored in `~/.pi/agent/auth.json` (mode 0600), refreshed five minutes before expiry under a file lock.
- pi warns the user at runtime: "Anthropic subscription auth is active. Third-party usage now draws from extra usage and is billed per token, not your Claude plan limits." Its maintainer on 2026-04-18: "we don't provide work arounds. as per the message as that's a ToS violation, you'll need to enable extra usage and get billed by token."

So pi's subscription path works by presenting itself as Claude Code, and it no longer gives the user their plan's limits.

## How opencode does it

- Today: API key only. No Anthropic sign-in is built in.
- Before March 2026: a built-in plugin, `opencode-anthropic-auth`, did what pi does (Claude Code's client, bearer token, the OAuth beta flag, a `claude-cli` user agent, a Claude Code system line, Tool-name rewriting). It was removed at Anthropic's request. Community plugins still exist; opencode's docs say Anthropic prohibits them.
- What is worth copying is the shape of its Provider-owned sign-in contract: a Provider lists methods (`key`, `env`, `oauth`); an OAuth method has `authorize` (returns a URL, instructions and whether the code comes back automatically or is pasted), a `callback` that yields a credential, an optional `refresh`, and a loader that turns the stored credential into request options (`packages/plugin/src/index.ts:88-208` in the checkout).
- For Copilot and ChatGPT it has first-party-style sign-ins, which their providers allow.

## What other agents do for a Claude subscription

| Agent           | Subscription access | How                                                                                             |
| --------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| Cline           | Yes                 | Spawns the user's own `claude` CLI                                                              |
| Goose           | Yes                 | Runs Claude Code through the Agent Client Protocol adapter                                      |
| Zed, JetBrains  | Yes                 | The same adapter (`@agentclientprotocol/claude-agent-acp`), which drives the official Agent SDK |
| opencode, Crush | No                  | Removed in 2026 at Anthropic's request                                                          |
| pi              | Unofficial          | Reuses Claude Code's client; billed as extra usage                                              |
| Aider, Continue | No                  | API key only                                                                                    |

Every tool that still offers a subscription path does it by running Anthropic's unmodified binary. In that mode the tool does not get a model endpoint: it gets Claude Code's own agent loop, tools and permission system.

## Sanctioned ways to authenticate

1. **API key.** What Mitome has. Anthropic's current docs show `Authorization: Bearer <key>` and call `x-api-key` the legacy header; keys can expire and can be scoped to a workspace (a key that is not needs an `anthropic-workspace-id` header). Since 2026-10-07 Max, Ultra and Team plans include monthly API credits for keys from the linked Console organisation, so a subscriber can use plan value through an API key.
2. **Console sign-in.** `ant auth login` opens a browser sign-in against the Claude Console and writes a profile under `~/.config/anthropic` (`credentials/<profile>.json`, mode 0600, with an access token, expiry and refresh token). Requests use `Authorization: Bearer sk-ant-oat01-…` and bill to the organisation. Claude Code itself now recommends this over creating an API key. The docs call it "intended for local development and scripting on your own machine". They do not say whether another tool may run the flow, and the client id is not published.
3. **Workload identity federation.** For CI and servers: an identity token is exchanged at `/v1/oauth/token` for a short-lived bearer token. `@effect/ai-anthropic` 4.1.5 already implements it.
4. **Cloud providers.** Bedrock, Vertex, Foundry.
5. **Running the `claude` binary.** A different integration (see the table above), not a credential for the Messages API.

## What Mitome has to build on

From the stack tip (`packages/mitome`, `packages/providers`, `packages/cli`):

- A Provider declares one credential: either the name of an environment variable, or a capability module that exports `authenticate` (`session/credential.ts`). `mitome auth login|logout` resolves that module from the Configuration and calls it with `operation`, `stateDirectory`, `input` and `output`.
- The Codex Provider is the OAuth precedent: PKCE, a loopback callback, a pasted-code fallback, tokens in `<state-dir>/auth.json` keyed by Provider id (mode 0600, atomic rewrite, cross-process lock), refresh before expiry. The helpers in `providers/src/shared/` are mostly generic; `authorize` assumes `localhost` and `exchangeToken` posts a form and expects a refresh token.
- One Provider id holds one credential kind. Offering a key and a sign-in means either two Providers (two ids, no contract change) or changing the descriptor type to a list of methods.
- `@effect/ai-anthropic` sends an API key as `x-api-key`. A bearer credential has to be added through `transformClient` with no `apiKey` set. Its only built-in bearer path is workload identity federation.
- A Provider cannot add system text of its own today; the kernel puts the Agent's Instructions first.

## Options

|     | What it is                                                                                                                                   | Work                                       | Standing with Anthropic                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| A   | API key only (today), sent as `Authorization: Bearer`, with workspace id and docs for plan API credits                                       | Small                                      | Sanctioned                                                                                         |
| B   | Read the profile `ant auth login` writes (`~/.config/anthropic`), refresh it, send bearer tokens. The user signs in with Anthropic's own CLI | Medium                                     | Uses Anthropic's own flow and files; consuming them from another tool is not addressed by the docs |
| C   | Mitome runs the Console sign-in itself (`mitome auth login --provider anthropic`)                                                            | Medium                                     | Unspecified; needs a client id Anthropic has not published for third parties                       |
| D   | Workload identity federation for CI                                                                                                          | Small (upstream has it)                    | Sanctioned                                                                                         |
| E   | Claude subscription sign-in as pi does it                                                                                                    | Medium                                     | Prohibited; requires presenting requests as Claude Code                                            |
| F   | A separate Host or Extension that drives the `claude` binary                                                                                 | Large, and a different kind of integration | Sanctioned for an end user's own login                                                             |

## The Console sign-in, verified (follow-up, 2026-11-22)

The owner chose an OAuth sign-in billed as API credits. That is the Claude Console sign-in. Read from Anthropic's public sources: the `ant` CLI (`anthropics/anthropic-cli`, `pkg/cmd/cmd_auth.go`), the TypeScript SDK (`anthropics/anthropic-sdk-typescript`, `src/lib/credentials/user-oauth.ts`, `src/client.ts`) and the platform docs.

- **Flow.** OAuth 2.0 authorization code with PKCE (S256). Authorize at `https://platform.claude.com/oauth/authorize`, token endpoint `https://api.anthropic.com/v1/oauth/token`, a loopback callback or a hosted paste-the-code page. The client id is a constant in the public CLI source. Default scopes `user:profile user:inference user:developer`.
- **Profile files.** `~/.config/anthropic/configs/<profile>.json` (non-secret: authentication mode, client id, organisation, workspace, base URL) and `credentials/<profile>.json` (secret, mode 0600: access token, expiry in seconds, refresh token). Selection: explicit, `ANTHROPIC_PROFILE`, an active-profile file, then `default`.
- **The official SDK reads and refreshes these profiles itself.** It sends `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20` (required), and `anthropic-workspace-id` when the profile names a workspace. It refreshes when fewer than 30 seconds remain and takes no cross-process lock.
- **Billing.** To the profile's Console organisation at API rates. A token is scoped to one workspace. Whether the monthly API credits of Max, Ultra and Team plans apply to it is not stated.
- **A known collision.** `ant auth login` and Claude Code's Console sign-in both default to the `default` profile; users report `ant auth login` switching Claude Code from a Max plan to API billing (https://github.com/anthropics/claude-code/issues/60901). A named profile avoids it.
- **What Anthropic says about other tools.** Nothing either way about a third-party tool reading a profile or using the CLI's client id. The consent page for that client presents it as the Anthropic CLI.
- **Anthropic's own third-party OAuth.** "Claude Platform OAuth / Linked billing" (beta since 2026-11-17, https://platform.claude.com/docs/en/manage-claude/oauth-apps/overview) lets a developer register an OAuth app. It requires a back end: pushed authorization requests, client authentication with a signed JWT from the developer's identity provider, a billing-only scope, and requests that run in the developer's organisation. It does not give a local CLI an inference token for the user's organisation, and plan API credits cannot pay for it.

Two designs follow from this:

|                         | B: use the profile `ant auth login` wrote                      | C: Mitome runs the browser flow itself                                                       |
| ----------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Who signs the user in   | Anthropic's own CLI                                            | Mitome                                                                                       |
| Client id               | Read from the profile; Mitome holds none                       | Mitome would have to use the Anthropic CLI's, and the consent page would say "Anthropic CLI" |
| Own client registration | Not needed                                                     | Not available for this flow                                                                  |
| What Mitome implements  | What the official SDK does: read, refresh, rewrite the profile | The whole flow, against a server contract that is not a published API                        |
| Needs                   | `ant` installed (or Claude Code's Console sign-in)             | Nothing extra                                                                                |

In `@effect/ai-anthropic` 4.1.5 a bearer credential goes through `transformClient` with no `apiKey`; the beta header has to be merged with the ones the library sets.

Found while building it, in the source of `ant` 2.12.1 and `@anthropic-ai/sdk` 1.12.0:

- `ant auth login --profile <name>` makes that profile `ant`'s active one; there is no flag to sign in without activating. `ant profile activate <name>` switches back.
- `ant auth logout` attempts to revoke the tokens, then deletes the credentials file and reports success either way; when the revocation fails (offline, for example) it only warns that the tokens remain valid. It keeps the profile's config file; a later login keeps that config.
- The SDK refuses a credentials file that other users can read or write, refreshes with under 30 seconds left, and after a 401 refreshes once and retries once.

## Unknown or unverified

- Whether Anthropic permits a third-party open-source CLI to run the Console sign-in flow, and what client id it would use.
- Whether the live Messages API rejects a Console bearer token sent without the `oauth-2025-04-20` beta. The SDK documents the value as required and always sends it, and so does Mitome; the rejection itself was not tested.
- How the server treats subscription tokens from other clients today; this was deliberately not tested.
- Mitome's Anthropic Provider has never been run against the live API.
