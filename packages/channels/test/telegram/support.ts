import type { ChannelHost, ChannelHostContext } from "@mitome/core";
import type {
  AnswerCallbackQueryParams,
  GetUpdatesParams,
  SendMessageParams,
  TelegramApi,
  TelegramUpdate,
} from "../../src/telegram/index.js";

/** Polls `predicate` until it holds; the Channel answers asynchronously through the fake API. */
export const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * In-memory Bot API: `getUpdates` hands out pushed updates (waiting when there are none) and
 * records outgoing calls. `failNextPoll` makes the next `getUpdates` reject once; `failNextSend`
 * does the same for `sendMessage`, recording the refused params under `rejected`.
 */
export const fakeApi = () => {
  const queue: Array<TelegramUpdate> = [];
  const polls: Array<{ readonly params: GetUpdatesParams; readonly at: number }> = [];
  const sent: Array<SendMessageParams> = [];
  const rejected: Array<SendMessageParams> = [];
  const answered: Array<AnswerCallbackQueryParams> = [];
  let waiting: ((updates: ReadonlyArray<TelegramUpdate>) => void) | undefined;
  let nextPollFailure: Error | undefined;
  let nextSendFailure: Error | undefined;
  let nextId = 1;

  const api: TelegramApi = {
    getUpdates: (params, signal) => {
      polls.push({ params, at: Date.now() });
      if (nextPollFailure !== undefined) {
        const failure = nextPollFailure;
        nextPollFailure = undefined;
        return Promise.reject(failure);
      }
      if (queue.length > 0) return Promise.resolve(queue.splice(0));
      return new Promise((resolve, reject) => {
        waiting = resolve;
        signal.addEventListener(
          "abort",
          () => {
            waiting = undefined;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    },
    sendMessage: async (params) => {
      if (nextSendFailure !== undefined) {
        const failure = nextSendFailure;
        nextSendFailure = undefined;
        rejected.push(params);
        throw failure;
      }
      sent.push(params);
    },
    answerCallbackQuery: async (params) => {
      answered.push(params);
    },
  };

  const push = (update: Omit<TelegramUpdate, "update_id">) => {
    const full = { update_id: nextId++, ...update };
    if (waiting === undefined) {
      queue.push(full);
      return;
    }
    const resolve = waiting;
    waiting = undefined;
    resolve([full]);
  };
  const message = (from: number, text: string, chat: number = from, thread?: number) =>
    push({
      message: {
        message_id: nextId,
        from: { id: from },
        chat: { id: chat },
        message_thread_id: thread,
        text,
      },
    });
  const callback = (from: number, data: string, chat: number = from, thread?: number) =>
    push({
      callback_query: {
        id: `query-${nextId}`,
        from: { id: from },
        data,
        message: { message_id: 0, chat: { id: chat }, message_thread_id: thread },
      },
    });
  const callbackFor = (sent: SendMessageParams, decision: "approve" | "deny"): string => {
    const button = sent.reply_markup?.inline_keyboard
      .flat()
      .find((button) => button.callback_data.startsWith(`${decision}:`));
    if (button === undefined) throw new Error("Prompt has no such button");
    return button.callback_data;
  };

  return {
    api,
    polls,
    sent,
    rejected,
    answered,
    message,
    callback,
    callbackFor,
    failNextPoll: (error: Error) => {
      nextPollFailure = error;
    },
    failNextSend: (error: Error) => {
      nextSendFailure = error;
    },
  };
};

/** Starts `serve` and returns a `stop` that aborts it and awaits its resolution. */
export const serving = (channel: ChannelHost, context: ChannelHostContext) => {
  const controller = new AbortController();
  const done = channel.serve!(context, controller.signal);
  return {
    done,
    stop: () => {
      controller.abort();
      return done;
    },
  };
};
