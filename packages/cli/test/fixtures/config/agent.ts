// The fixture Agent: an ordinary program with shutdown probes and a text mapping.
import { Context, Effect, Schema } from "effect";
import { Prompt } from "effect/ai";
import { Agent, Turn } from "@mitome/core";
import { record } from "../record.ts";
import { billing } from "./billing.ts";

/** Provided by the Configuration's layer; the text mapping renders with it. */
export class Greeting extends Context.Service<Greeting, { readonly prefix: string }>()(
  "fixture/Greeting",
) {}

class Unparseable extends Schema.TaggedError<Unparseable, { readonly brand: unique symbol }>()(
  "Unparseable",
  {},
) {
  override get message(): string {
    return "unparseable input";
  }
}

class Refused extends Schema.TaggedError<Refused, { readonly brand: unique symbol }>()("Refused", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `refused: ${this.reason}`;
  }
}

export const agent = Agent.make({
  use: [billing],
  /**
   * The ordinary program; `hold` and `wait` exercise shutdown with stuck and prompt cleanup, and
   * `log` writes a log line.
   */
  program: (message: string, { loop }) =>
    Effect.gen(function* () {
      record(`program:${message}`);
      const turn = yield* Turn;
      if (message === "log") yield* Effect.logInfo("fixture log line");
      if (message === "fail") return yield* new Refused({ reason: "asked to fail" });
      if (message === "hold" || message === "wait") {
        yield* Effect.addFinalizer(() =>
          message === "hold" ? Effect.never : Effect.sync(() => record("turn:cleanup")),
        );
        record(`turn:${message}`);
        return yield* Effect.never;
      }
      yield* turn.stage(Prompt.userMessage({ content: [Prompt.textPart({ text: message })] }));
      const result = yield* loop;
      return { text: result.response.text, turn: turn.id };
    }),
  text: {
    parse: (text: string) =>
      text.trim() === "unparseable" ? Effect.fail(new Unparseable()) : Effect.succeed(text.trim()),
    render: (result) =>
      result.text.endsWith("unrenderable")
        ? Effect.fail(new Refused({ reason: "cannot render" }))
        : Effect.map(Greeting, ({ prefix }) => `${prefix}${result.text}`),
  },
});
