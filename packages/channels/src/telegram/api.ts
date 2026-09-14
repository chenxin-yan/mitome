import { Data, Option, Schema } from "effect";

/** A Telegram user, reduced to the field the Channel reads. */
export interface TelegramUser {
  readonly id: number;
}

/** A Telegram chat, reduced to the field the Channel reads. */
export interface TelegramChat {
  readonly id: number;
}

/** A Telegram message, reduced to the fields the Channel reads; `text` is absent on media. */
export interface TelegramMessage {
  readonly message_id: number;
  readonly from?: TelegramUser | undefined;
  readonly chat: TelegramChat;
  /** Forum topic the message belongs to; absent outside topics. */
  readonly message_thread_id?: number | undefined;
  readonly text?: string | undefined;
}

/** An inline-keyboard press; `message` is the prompt the keyboard was attached to. */
export interface TelegramCallbackQuery {
  readonly id: string;
  readonly from: TelegramUser;
  readonly message?: TelegramMessage | undefined;
  readonly data?: string | undefined;
}

/** One Bot API update; the Channel reads `message` and `callback_query` only. */
export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage | undefined;
  readonly callback_query?: TelegramCallbackQuery | undefined;
}

/** An inline keyboard: rows of buttons whose `callback_data` comes back in a callback query. */
export interface TelegramInlineKeyboard {
  readonly inline_keyboard: ReadonlyArray<
    ReadonlyArray<{ readonly text: string; readonly callback_data: string }>
  >;
}

/** Parameters of `getUpdates`; `timeout` is the long-poll wait in seconds. */
export interface GetUpdatesParams {
  readonly offset?: number | undefined;
  readonly timeout: number;
  readonly allowed_updates: ReadonlyArray<"message" | "callback_query">;
}

/** Parameters of `sendMessage`. */
export interface SendMessageParams {
  readonly chat_id: number;
  readonly message_thread_id?: number | undefined;
  readonly text: string;
  readonly reply_markup?: TelegramInlineKeyboard | undefined;
}

/** Parameters of `answerCallbackQuery`; `text` is shown to the user as a notification. */
export interface AnswerCallbackQueryParams {
  readonly callback_query_id: string;
  readonly text?: string | undefined;
}

/**
 * The Bot API methods the Channel calls, typed to the fields it uses. `telegram()` builds the
 * `fetch`-based one from its token; tests and other transports pass their own through `api`.
 * `getUpdates` receives the signal the Channel aborts on shutdown so an in-flight long poll ends
 * at once. A rejected `getUpdates` makes the Channel back off and poll again, honouring
 * `TelegramApiError.retryAfterMs` when present; a rejected `sendMessage` or `answerCallbackQuery`
 * loses that one reply.
 */
export interface TelegramApi {
  readonly getUpdates: (
    params: GetUpdatesParams,
    signal: AbortSignal,
  ) => Promise<ReadonlyArray<TelegramUpdate>>;
  readonly sendMessage: (params: SendMessageParams) => Promise<void>;
  readonly answerCallbackQuery: (params: AnswerCallbackQueryParams) => Promise<void>;
}

/** The Bot API answered `ok: false`, or its response could not be read. It never carries the token. */
export class TelegramApiError extends Data.TaggedError("TelegramApiError")<{
  readonly method: string;
  readonly description: string;
  /** Set when Telegram asked to wait before retrying (`429`); the poll loop honours it. */
  readonly retryAfterMs?: number | undefined;
}> {}

const User = Schema.Struct({ id: Schema.Number });
const Message = Schema.Struct({
  message_id: Schema.Number,
  from: Schema.optional(User),
  chat: Schema.Struct({ id: Schema.Number }),
  message_thread_id: Schema.optional(Schema.Number),
  text: Schema.optional(Schema.String),
});
const CallbackQuery = Schema.Struct({
  id: Schema.String,
  from: User,
  message: Schema.optional(Message),
  data: Schema.optional(Schema.String),
});
// An update whose payload has an unexpected shape still advances the offset instead of stalling the poll.
const Update = Schema.Union([
  Schema.Struct({
    update_id: Schema.Number,
    message: Schema.optional(Message),
    callback_query: Schema.optional(CallbackQuery),
  }),
  Schema.Struct({ update_id: Schema.Number }),
]);
// The envelope of every Bot API response; `result` is parsed per method.
const apiResponse = <Result extends Schema.Decoder<unknown>>(result: Result) =>
  Schema.Struct({
    ok: Schema.Boolean,
    result: Schema.optional(result),
    description: Schema.optional(Schema.String),
    parameters: Schema.optional(Schema.Struct({ retry_after: Schema.optional(Schema.Number) })),
  });
const Updates = Schema.Array(Update);

// Telegram closes an idle long poll itself; the margin only catches a connection that hung.
const longPollMarginMs = 10_000;

/** The default transport: `fetch` against `https://api.telegram.org/bot<token>/<method>`. */
export const createTelegramApi = (token: string): TelegramApi => {
  const call = async <Result extends Schema.Decoder<unknown>>(
    method: string,
    params: GetUpdatesParams | SendMessageParams | AnswerCallbackQueryParams,
    result: Result,
    signal: AbortSignal | null = null,
  ): Promise<Result["Type"] | undefined> => {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal,
    });
    const body = Option.getOrUndefined(
      Schema.decodeUnknownOption(apiResponse(result))(await response.json().catch(() => undefined)),
    );
    if (body === undefined) {
      throw new TelegramApiError({ method, description: `HTTP ${response.status}` });
    }
    if (!body.ok) {
      const retryAfter = body.parameters?.retry_after;
      throw new TelegramApiError({
        method,
        description: body.description ?? `HTTP ${response.status}`,
        retryAfterMs: retryAfter === undefined ? undefined : retryAfter * 1000,
      });
    }
    return body.result;
  };
  return {
    getUpdates: async (params, signal) => {
      const updates = await call(
        "getUpdates",
        params,
        Updates,
        AbortSignal.any([signal, AbortSignal.timeout(params.timeout * 1000 + longPollMarginMs)]),
      );
      if (updates === undefined) {
        throw new TelegramApiError({ method: "getUpdates", description: "Response has no result" });
      }
      return updates;
    },
    sendMessage: async (params) => {
      await call("sendMessage", params, Schema.Unknown);
    },
    answerCallbackQuery: async (params) => {
      await call("answerCallbackQuery", params, Schema.Unknown);
    },
  };
};
