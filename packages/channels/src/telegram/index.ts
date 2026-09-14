/**
 * Telegram Channel: long-polls a bot's updates and answers each allowed sender's message with one
 * reply per Turn.
 *
 * @module @mitome/channels/telegram
 */

import {
  createSession,
  type ChannelHost,
  type ChannelHostContext,
  type RouteKey,
  type Routes,
  type StoreError,
  type TurnEvent,
} from "@mitome/core";
import { type Cause, Effect, Exit, Inspectable, Stream } from "effect";
import { createPendingApprovals } from "../shared/pending-approvals.js";
import { createRouteLock } from "../shared/route-lock.js";
import { loadRouteTranscript } from "../shared/route-transcript.js";
import {
  createTelegramApi,
  TelegramApiError,
  type TelegramApi,
  type TelegramCallbackQuery,
  type TelegramInlineKeyboard,
  type TelegramMessage,
  type TelegramUpdate,
} from "./api.js";

export { TelegramApiError } from "./api.js";
export type {
  AnswerCallbackQueryParams,
  GetUpdatesParams,
  SendMessageParams,
  TelegramApi,
  TelegramCallbackQuery,
  TelegramChat,
  TelegramInlineKeyboard,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "./api.js";

/** Options for `telegram()`. */
export interface TelegramOptions {
  /** Bot token from @BotFather. */
  readonly token: string;
  /**
   * Telegram user ids allowed to talk to the Agent, as numbers or their decimal string form. A
   * sender not listed gets no reply and starts no Session; an empty list allows nobody.
   */
  readonly allow: ReadonlyArray<string | number>;
  /** Route store mapping `(name, user id, chat)` to the latest Transcript, such as `fileRoutes()`. */
  readonly routes: Routes;
  /**
   * `"deny"` (default) answers every pending Approval with a stable denial the Model sees.
   * `"interactive"` posts an Approve/Deny inline keyboard in the chat and denies the Approval
   * after `approvalTimeoutMs`. Unflagged and Agent-allowed Tool calls run in both modes; there is
   * no auto-approve mode, run unattended through the Agent's `approvals.allow`.
   */
  readonly approvals?: "deny" | "interactive" | undefined;
  /** How long an `"interactive"` Approval may stay unanswered before it is denied. Defaults to 5 minutes. */
  readonly approvalTimeoutMs?: number | undefined;
  /** Channel Host name, unique in its Mitome Definition. Defaults to `"telegram"`. */
  readonly name?: string | undefined;
  /** Bot API transport; defaults to `fetch` against `api.telegram.org` with `token`. */
  readonly api?: TelegramApi | undefined;
}

type ApprovalRequiredEvent = Extract<TurnEvent, { readonly type: "approval-required" }>;

/** Where a reply goes: the chat and, inside a forum topic, the thread. */
interface Target {
  readonly chat_id: number;
  readonly message_thread_id?: number | undefined;
}

const messageLimit = 4096;
const pollTimeoutSeconds = 30;
const pollRetryMs = 1000;
const callbackData = /^(approve|deny):(.+)$/;
const botCommand = /^\/(\w+)(?:@\w+)?(?:\s|$)/;

const busyReply = "Still working on your previous message.";
const failedReply = "Something went wrong; try again.";
const newReply = "Started a new conversation.";
const startReply = "Send a message to talk to the Agent; /new starts a fresh conversation.";
const notPendingAnswer = "This Approval is no longer pending.";
const notYoursAnswer = "This Approval is not yours to decide.";

const conversationOf = (message: TelegramMessage): string =>
  message.message_thread_id === undefined
    ? String(message.chat.id)
    : `${message.chat.id}/${message.message_thread_id}`;

const targetOf = (message: TelegramMessage): Target => ({
  chat_id: message.chat.id,
  message_thread_id: message.message_thread_id,
});

/** Splits at Telegram's per-message limit without separating a surrogate pair. */
const splitMessage = (text: string): Array<string> => {
  const chunks: Array<string> = [];
  let rest = text;
  while (rest.length > messageLimit) {
    const end = /[\uD800-\uDBFF]/.test(rest[messageLimit - 1]!) ? messageLimit - 1 : messageLimit;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  chunks.push(rest);
  return chunks;
};

const keyboard = (id: string): TelegramInlineKeyboard => ({
  inline_keyboard: [
    [
      { text: "Approve", callback_data: `approve:${id}` },
      { text: "Deny", callback_data: `deny:${id}` },
    ],
  ],
});

/**
 * Creates the Telegram Channel Host. `serve` long-polls `getUpdates` until the signal aborts, then
 * interrupts running Turns and resolves; it never rejects because of a transport error. Only
 * senders in `allow` are answered, and the Route key is `(name, user id, chat[/thread])`, so a
 * Session is never shared across users of one group. One Turn runs per Route at a time; a message
 * that arrives meanwhile is answered `Still working on your previous message.` and dropped. The
 * Model's text is sent as one message when the Turn completes, `/new` forgets the Route, and a
 * failed Turn is one sanitized line. Pending Approvals live in memory for the Turn only; a
 * decision must come from the Turn's own user in the Turn's own chat, and a stale or repeated one
 * never re-executes a Tool.
 */
export const telegram = (options: TelegramOptions): ChannelHost => {
  const name = options.name ?? "telegram";
  const interactive = options.approvals === "interactive";
  const api = options.api ?? createTelegramApi(options.token);
  const allowed = new Set(options.allow.map(String));
  const withLock = createRouteLock();

  // Stable, Model-visible text; it never carries exception details.
  const defaultDenial = `Approval denied: the telegram Channel "${name}" does not resolve Approvals (set approvals: "interactive" or list the Tool under approvals.allow)`;
  const pending = createPendingApprovals(
    options.approvalTimeoutMs ?? 300_000,
    `Approval denied: the telegram Channel "${name}" received no decision before the Approval timed out`,
  );

  // Fails at the first chunk Telegram rejects, so a keyboard never follows a prompt it belongs to.
  const deliver = (target: Target, text: string, markup?: TelegramInlineKeyboard) => {
    const chunks = splitMessage(text);
    return Effect.forEach(
      chunks,
      (chunk, index) =>
        Effect.tryPromise(() =>
          api.sendMessage({
            ...target,
            text: chunk,
            reply_markup: index === chunks.length - 1 ? markup : undefined,
          }),
        ),
      { discard: true },
    );
  };

  // A lost reply is not a Channel failure; the Turn is committed and the Route advanced already.
  const send = (target: Target, text: string): Effect.Effect<void> =>
    Effect.ignore(deliver(target, text));

  const answer = (query: TelegramCallbackQuery, text: string): Effect.Effect<void> =>
    Effect.ignore(
      Effect.tryPromise(() => api.answerCallbackQuery({ callback_query_id: query.id, text })),
    );

  const runTurn = (
    context: ChannelHostContext,
    key: RouteKey,
    target: Target,
    text: string,
  ): Effect.Effect<void> =>
    withLock(
      key,
      Effect.scoped(
        Effect.gen(function* () {
          const sessionScope = yield* Effect.scope;
          const transcript = yield* loadRouteTranscript(options.routes, context, key);
          const session = yield* createSession(context.agent, {
            transcripts: context.transcripts,
            transcript,
          });
          const committedMessages = session.history().length;
          const advanceRoute = options.routes.set(key, session.transcript().id);
          const prompt = (event: ApprovalRequiredEvent) => {
            // callback_data is limited to 64 bytes, so the keyboard carries a Channel-minted id.
            const id = crypto.randomUUID();
            return pending
              .register(id, { key, approve: event.approve, deny: event.deny }, sessionScope)
              .pipe(
                Effect.andThen(
                  deliver(
                    target,
                    `Tool ${event.name} (${event.requirement}) wants to run: ${Inspectable.toStringUnknown(event.params, 0)}`,
                    keyboard(id),
                  ),
                ),
                // A prompt nobody saw would park the Turn on its Route until the timeout; the
                // failure ends the Turn instead, and the entry goes before a press can find it.
                Effect.tapError(() =>
                  Effect.sync(() => {
                    pending.take(id);
                  }),
                ),
              );
          };
          let reply = "";
          const outcome = yield* session.runTurn(text).pipe(
            Stream.runForEach((event): Effect.Effect<void, Cause.UnknownError | StoreError> => {
              if (event.type === "model-output") {
                reply += event.text;
                return Effect.void;
              }
              if (event.type === "approval-required") {
                return interactive ? prompt(event) : Effect.ignore(event.deny(defaultDenial));
              }
              // The Route advances before the user learns the Turn completed.
              return event.type === "response-complete" ? advanceRoute : Effect.void;
            }),
            Effect.map(() => reply),
            // Fixed text: a TurnError may carry the Provider's own message, and the chat is not the operator.
            Effect.catchTags({
              TurnError: () => Effect.succeed(failedReply),
              SessionBusyError: () => Effect.succeed(failedReply),
              SessionReleasedError: () => Effect.succeed(failedReply),
              // The Turn may already be committed when its final event record fails to append.
              StoreError: () =>
                (session.history().length > committedMessages
                  ? Effect.ignore(advanceRoute)
                  : Effect.void
                ).pipe(Effect.as(failedReply)),
            }),
            Effect.catchDefect(() => Effect.succeed(failedReply)),
          );
          if (outcome !== "") yield* send(target, outcome);
        }),
      ),
    ).pipe(
      Effect.catchTag("RouteBusyError", () => send(target, busyReply)),
      Effect.catch(() => send(target, failedReply)),
      Effect.catchDefect(() => send(target, failedReply)),
    );

  const onMessage = (
    context: ChannelHostContext,
    message: TelegramMessage,
  ): Effect.Effect<void> => {
    // Silence is the deny: an unlisted sender learns nothing, not even that a bot is listening.
    if (message.from === undefined || !allowed.has(String(message.from.id))) return Effect.void;
    if (message.text === undefined) return Effect.void;
    const key: RouteKey = {
      channel: name,
      principal: String(message.from.id),
      conversation: conversationOf(message),
    };
    const target = targetOf(message);
    const command = botCommand.exec(message.text)?.[1];
    if (command === "start") return send(target, startReply);
    if (command === "new") {
      return withLock(
        key,
        options.routes.clear(key).pipe(Effect.andThen(send(target, newReply))),
      ).pipe(
        Effect.catchTag("RouteBusyError", () => send(target, busyReply)),
        Effect.catch(() => send(target, failedReply)),
      );
    }
    return runTurn(context, key, target, message.text);
  };

  // Decisions never take the Route lock: they must reach the Turn that is holding it.
  const onCallback = (query: TelegramCallbackQuery): Effect.Effect<void> => {
    if (!allowed.has(String(query.from.id))) return Effect.void;
    const parsed = callbackData.exec(query.data ?? "");
    const entry = parsed === null ? undefined : pending.peek(parsed[2]!);
    if (parsed === null || entry === undefined) return answer(query, notPendingAnswer);
    // IDs are correlation, not authorization: the Turn's own user, in the Turn's own chat and thread.
    if (
      entry.key.principal !== String(query.from.id) ||
      query.message === undefined ||
      entry.key.conversation !== conversationOf(query.message)
    ) {
      return answer(query, notYoursAnswer);
    }
    pending.take(parsed[2]!);
    const approving = parsed[1] === "approve";
    return Effect.exit(
      approving ? entry.approve() : entry.deny("Approval denied by the user."),
    ).pipe(
      // A decision that no longer applies (the Turn ended meanwhile) is stale and never re-executes.
      Effect.flatMap((exit) =>
        answer(
          query,
          Exit.isSuccess(exit) ? (approving ? "Approved." : "Denied.") : notPendingAnswer,
        ),
      ),
    );
  };

  const dispatch = (context: ChannelHostContext, update: TelegramUpdate): Effect.Effect<void> => {
    if (update.callback_query !== undefined) return onCallback(update.callback_query);
    if (update.message !== undefined) return onMessage(context, update.message);
    return Effect.void;
  };

  return {
    kind: "channel",
    name,
    serve: (context, signal) => {
      const poll = Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          let offset: number | undefined;
          for (;;) {
            const updates = yield* Effect.tryPromise({
              try: (abort) =>
                api.getUpdates(
                  {
                    offset,
                    timeout: pollTimeoutSeconds,
                    allowed_updates: ["message", "callback_query"],
                  },
                  abort,
                ),
              // Any failure, network or Bot API, is a delay before the next poll; never a stop.
              catch: (cause) =>
                cause instanceof TelegramApiError
                  ? (cause.retryAfterMs ?? pollRetryMs)
                  : pollRetryMs,
            }).pipe(
              Effect.catch((delayMs) =>
                Effect.sleep(delayMs).pipe(Effect.as<ReadonlyArray<TelegramUpdate>>([])),
              ),
            );
            for (const update of updates) {
              offset = update.update_id + 1;
              // Started at once so two messages of one batch reach the Route lock in order.
              yield* Effect.forkIn(dispatch(context, update), scope, { startImmediately: true });
            }
          }
        }),
      );
      // Abort interrupts the poll fiber; closing its scope interrupts every Turn and its Session.
      return Effect.runPromiseExit(poll, { signal }).then(() => undefined);
    },
  };
};
