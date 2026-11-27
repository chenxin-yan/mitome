---
status: accepted
---

# Sign in to Anthropic through the Console profile

The Anthropic Provider accepts two Credentials: an API key, and the Claude Console sign-in. For the sign-in Mitome does not run an OAuth flow of its own. The person signs in with Anthropic's own `ant auth login`, which writes a profile under the Anthropic config directory, and Mitome reads that profile and refreshes its token as Anthropic's SDKs do. `mitome auth login` for this Provider runs the person's `ant auth login` for that profile, and `mitome auth logout` runs `ant auth logout` for it, which attempts to revoke the tokens and removes that profile's credentials and no other's, even when the revocation fails. Both Credentials are billed to a Console organisation at API rates; an API key in the environment wins when both are present.

The Claude subscription sign-in is not supported. Anthropic's terms say third-party developers may not "offer Claude.ai login into their own applications, or … route requests through Free, Pro, Max, or Ultra plan credentials", and two comparable projects removed it in 2026 at Anthropic's request. It only works by presenting requests as Claude Code.

Mitome uses a profile named `mitome` by default. Anthropic's CLI and Claude Code share the `default` profile, and signing in to it is known to move a person's Claude Code from their plan to API billing.

The research is in `docs/research/anthropic-auth.md`.

## Considered options

- **The Claude subscription sign-in, as pi does it.** Prohibited by Anthropic, and since April 2026 billed as extra usage, not against the plan.
- **Mitome runs the Console flow itself.** A local tool cannot register a client for that flow, so Mitome would have to use the Anthropic CLI's client id and present its own sign-in under that name, against a server contract Anthropic does not publish.
- **Anthropic's OAuth for third-party applications (linked billing).** It needs a hosted back end and a signed client identity, and bills through the developer's organisation. It does not fit a program that runs on the person's machine.

## Consequences

The sign-in needs Anthropic's CLI installed. Mitome holds no OAuth client id: it reads the one the profile records. The official SDK takes no lock when it refreshes a profile, so Mitome takes its own and re-reads the file before refreshing; another tool can still refresh at the same time.

Mitome reads the named profile only: `ant`'s active profile and `ANTHROPIC_PROFILE` are not consulted. Signing in with `ant auth login --profile mitome` also makes `mitome` the active profile of `ant`, because `ant` has no way to sign in without activating; other Anthropic tools that name no profile then follow it until the person runs `ant profile activate` for another. `mitome auth login` says so before it runs `ant`.

Tokens are sent only to an https host, or to http on the same machine. When the Model endpoint answers 401 to a request sent with the profile's token, Mitome refreshes once and retries once, as the SDK does; a request sent with an API key is never retried this way. The refresh token goes only to the host that issued it: the profile's `base_url`, else Anthropic's.

Using a subscription's limits remains possible only by running Anthropic's unmodified `claude` program, which is a different integration: a child Agent in Delegation, not a Provider.
