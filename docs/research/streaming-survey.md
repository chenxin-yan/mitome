# How other harnesses and frameworks stream, and what fits Mitome

Question: Mitome shows nothing while the model writes, because a Step waits for the whole response. How do other systems stream output, and which approach fits Mitome's rules (a Turn commits whole or not at all; a response is validated before any Tool runs; a viewer must never slow or stop a Turn)?

Researched 2026-11-17 by three read-only researchers. Claims from local sources were re-read at the cited places. Claims about the Vercel AI SDK and the Claude Agent SDK come from the researcher's reading of the official documentation at the URLs given and were not re-checked. Nothing was run.

Sources:

- **pi** 1.5.2: installed docs and `dist/`, paths relative to the installed `pi-monorepo` directory.
- **opencode**: local checkout at `85e278b` (2026-06-14), not the current product.
- **fx**: `.agent-sources/fx` at `14a2dbb`.
- **eve**: `.agent-sources/eve` at `eve@0.54.3`.
- **Effect AI**: installed `effect@4.0.0`, `src/ai`.
- **Mitome**: `feat/effect-native-tui-185` at `584f408`.
- **Vercel AI SDK** v7: https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text, https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol, https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams, https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence.
- **Claude Agent SDK**: https://code.claude.com/docs/en/agent-sdk/streaming-output, https://code.claude.com/docs/en/agent-sdk/typescript.

## What everyone shares

Every system has the same two layers: small "delta" events while the model writes, and one complete event that is the real value.

| System           | Delta events                                                                                                             | The authoritative event                                                         | When history is written                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| pi               | `text_delta`, `thinking_delta`, `toolcall_delta` inside `message_update` (`docs/json.md:70-99`)                          | "`message_end` contains the authoritative completed message" (`docs/sdk.md:92`) | Per message (`dist/core/agent-session.js:811-826`)          |
| opencode         | `text.delta`, `reasoning.*`, `tool.input.delta`, live only (`packages/core/src/session/event.ts`)                        | `text.ended` is "the replayable full-value boundary" (`event.ts:235`)           | Per part, to a database with a sequence                     |
| fx               | `text_delta`, `reasoning_delta` (`sdk/types/libfx.d.cts:244-253`)                                                        | `turn_committed` in the journal (`src/core/agent/runtime/journal.zig:14-19`)    | Per turn; deltas are never journaled                        |
| eve              | `message.appended`, `reasoning.appended`, `action.input.appended` (`docs/concepts/sessions-runs-and-streaming.md:48-78`) | `*.completed` events                                                            | Each event is recorded; history keeps the completed attempt |
| Effect AI        | `text-delta`, `reasoning-delta`, `tool-params-delta` (`Response.ts:320-349`)                                             | `tool-call` and `finish` parts                                                  | Not its job                                                 |
| Vercel AI SDK    | `text-delta`, `reasoning-delta`, `tool-input-delta`                                                                      | `tool-call`, `finish-step`                                                      | The application saves in `onEnd`                            |
| Claude Agent SDK | `stream_event` wrapping `text_delta`, `input_json_delta`, opt-in                                                         | One complete assistant message per block; a final `result` message              | Session file; timing not documented                         |

## Where they differ

**A slow or absent viewer.**

- pi: "a client that stops reading can stall the process" (`docs/rpc.md:56`); extension handlers on stream events are awaited in order.
- eve: the stream writer holds at most 64 events or 64 KiB and then pauses the model stream (`packages/eve/src/harness/ordered-stream-emitter.ts:14-15, 120-163`).
- fx hooks: "returned promises are not awaited. The host owns buffering and flushing" (`sdk/types/libfx.d.cts:342`). Its in-process turn iterator, however, waits after 256 unread events or 1 MiB (`sdk/engine.js:29-30`).
- Vercel AI SDK: `onChunk` pauses the stream until its promise resolves; when the client disconnects the model stream is aborted unless the server calls `consumeStream()`.
- opencode: an unbounded queue per SSE client and no event ids (`packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:16, 31`).

**Cancelling mid-stream.**

- fx and eve save nothing of the unfinished response.
- opencode keeps the partial text as finished content (`packages/opencode/src/session/processor.ts:268-281`).
- Claude Agent SDK marks the message `aborted`; the Vercel AI SDK reports completed steps only.

**Retrying a step that already showed output.** The Vercel AI SDK has a `reset-step` event that "removes all message parts received since the most recent `start-step`". eve re-emits under new event ids.

**Reconnecting.** fx reads from a cursor over its durable log (`sdk/README.md:81-105`). eve resumes by index and removes duplicates by event id. The Vercel AI SDK leaves it to the application (a Redis-backed replay). pi and opencode have none in the protocol.

**A hook that throws.** In eve "a thrown handler … surfaces as `turn.failed`" (`docs/guides/hooks.md:178`). fx contains the error in `onError`.

**Tool calls.** All show a call before it runs. pi, the Vercel AI SDK, eve and Claude also stream the arguments as they are written. Progress from a running Tool exists in pi (`tool_execution_update`), eve (`action.partial`), Effect AI (`preliminary`, `Toolkit.ts:123-130`) and the Vercel AI SDK (a generator that yields); fx has none.

**Subagents.** Claude forwards only complete messages from a subagent, tagged with the parent call; token deltas "from subagents aren't forwarded". fx reports child phases with a child session id and does not forward child text. eve gives the child its own stream and copies events to the parent.

## Mitome today

- A Step calls `model.generateText({ …, disableToolCallResolution: true })` and then validates the whole response (`packages/core/src/session/step.ts:558-569`).
- A Tool handler's stream is collected and only the last value kept; preliminary results are dropped (`step.ts:436-437`).
- `Session.observe` delivers one snapshot per Turn, at its end, through a sliding queue (`packages/core/src/session/session.ts:379-386, 408-422`).
- The terminal never subscribes; it rereads state after each run (`packages/tui/src/index.ts`).
- Effect AI already offers what is needed: `LanguageModel.streamText` returns a `Stream` of parts and honours `disableToolCallResolution` (`LanguageModel.ts:1960`). The OpenAI binding and Mitome's Codex binding both implement it.

## What fits Mitome (judgement)

1. Deltas are for display only. The Turn still commits at the end, and a cancelled Turn saves nothing. This is what fx and eve do and what the whole-Turn commit already implies.
2. Switch the Step from `generateText` to `streamText`, fold the parts into the same complete response, and keep validation and Tool dispatch unchanged after the fold. Text appears as it arrives, and no Tool runs earlier than today.
3. A viewer gets a bounded buffer and loses deltas when it falls behind; the complete event carries the full value, so it is corrected. Do not copy backpressure into the Turn (eve's writer, the Vercel `onChunk`, pi's awaited handlers).
4. An extension's event handler is not awaited and its errors are contained, as fx does and unlike eve.
5. Anything shown before the complete event is provisional. A retried Step needs a way to withdraw what was shown, as `reset-step` does.
6. Forward a Tool handler's preliminary results as progress events.
7. Leave reconnecting to server Hosts, built on the durable store's committed log when it exists. Replaying deltas is not needed for in-process viewers.
8. For subagents later: tag events with the parent and forward complete messages, not token deltas.
