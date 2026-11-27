---
status: accepted; the rule for parameters that are not plain data amended by ADR-0066
---

# Let the Host answer Approvals, and deny when nobody can

The Host that runs a Turn supplies who answers a pending Approval, and when no Host supplies anyone the answer is a denial the Model is told about. The Agent and its Configuration wire nothing. The first native implementation, closed unmerged, had the application allocate a process-local Approval channel, pass it to its Agent program as consent and separately grant it to the terminal; a one-shot run never read that channel and waited until it was interrupted.

[ADR-0051](0051-let-the-agent-author-decide-tool-approvals.md) keeps authority where it was: the Tool author flags risk, the Agent author's policy decides, and the runtime enforces the decision once, failing closed: policy decides on the decoded arguments, and an Approval is bound to the JSON the Model sent. This record settles only who resolves a permitted ask. It makes [ADR-0019](0019-keep-the-cli-non-interactive.md)'s rule, that a required Approval with nobody present is denied with a stable Model-visible reason, hold for every Host and for embedded use instead of for one command.

Two narrow contracts cross the Host seam, and one Host supplies both:

- **The approver** answers one Tool Call: allow once, allow for the rest of the Session, or deny. Only the runtime's Tool gate calls it. Code in an Extension or a Tool handler is never handed it, so it cannot present something that looks like an Approval while the runtime checks nothing.
- **The interaction** lets Extension and Tool code ask the person a question or notify them. With nobody present a question reports that nobody answered and a notification is logged.

They are separate because their callers, stakes and defaults differ, and because the interaction will grow while the Approval path must stay small. A status line was left out of the interaction: only a terminal has one.

On a Channel, only the Principal whose Message started the Turn may answer its Approvals; `CONTEXT.md` already gives that Principal its control decisions. A scheduled run has no such Principal, so its asks are denied. A rule naming other approvers can be added when a shared Agent needs it.

## Considered options

- **The application owns the channel**, as before. Four pieces of wiring, and a Host that was never granted the channel leaves the Turn waiting.
- **An approver passed on every run.** Nothing is ambient, but Extension code that needs the person would have to be handed it by every caller.
- **One service for Approvals and questions.** Any code able to ask a question could also raise an Approval.

## Consequences

Because Extensions are data ([ADR-0058](0058-describe-an-agent-as-data-and-run-it-through-a-configuration.md)), a Host can list, before the run, the Tools an Agent declares; only the gate decides, for each call and its arguments, whether that call is allowed, asked about or denied. "Allow for the rest of the Session" lives in memory and ends with the Session; a permanent rule is policy written in the Configuration ([ADR-0060](0060-load-one-configuration-and-keep-logins-out-of-it.md)).

The first implementation carries the approver only. The interaction and the Session-long grant follow when an Extension needs them.

## Amendment, 2026-11-23

The Approver is shown the JSON the Model sent for a Tool Call, without the fields the Tool does not declare: Effect drops them when it reads the response, so the handler never receives them either. The Approval is bound to that JSON. Mitome decodes it once with the Tool's schema, before policy runs, and policy, Extension restrictions, the Tool's own risk flag and the handler all decide on and receive that one decoded value; nothing is decoded again after the person answers. Like Effect's own tool-approval flow, a call travels as its encoded part; unlike it, an approved call is not decoded a second time, so a decoder with effects cannot hand the handler a value policy never checked. Decoded values such as a `URL`, a `Date`, a `Map` or a class instance could neither be displayed truthfully nor be kept fixed while a person decided. A call whose parameters are not plain data never reaches the gate: since [ADR-0066](0066-keep-history-as-a-tree-of-steps.md) a Model response that holds anything else is refused as malformed before policy runs, so what the Approver is shown is always plain data.
