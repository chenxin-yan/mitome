import * as BunTerminal from "@effect/platform-bun/BunTerminal";
import { Context, Effect, Layer, Redacted, Terminal } from "effect";
import { Prompt } from "effect/unstable/cli";

export interface PromptChoice<A> {
  readonly title: string;
  readonly value: A;
}

export class Prompter extends Context.Service<
  Prompter,
  {
    readonly canPrompt: Effect.Effect<boolean>;
    readonly select: <A>(options: {
      readonly message: string;
      readonly choices: ReadonlyArray<PromptChoice<A>>;
    }) => Effect.Effect<A>;
    readonly text: (message: string) => Effect.Effect<string>;
    readonly password: (message: string) => Effect.Effect<string>;
  }
>()("@mitome/cli/Prompter") {
  static readonly layer = Layer.effect(
    Prompter,
    Effect.gen(function* () {
      let stdinEnded = false;
      const markStdinEnded = () => {
        stdinEnded = true;
      };
      process.stdin.once("end", markStdinEnded);
      yield* Effect.addFinalizer(() => Effect.sync(() => process.stdin.off("end", markStdinEnded)));

      let stdinTrackingStarted = false;
      const terminal = yield* BunTerminal.make();
      const context = Context.add(
        yield* Effect.context<Prompt.Environment>(),
        Terminal.Terminal,
        terminal,
      );

      return {
        canPrompt: Effect.sync(() => {
          if (!stdinTrackingStarted) {
            stdinTrackingStarted = true;
            // Bun never sets readableEnded; a passive listener starts EOF detection without consuming input.
            process.stdin.once("readable", () => {});
          }
          return process.stdin.isTTY === true || process.stdin.readableLength > 0 || !stdinEnded;
        }),
        select: <A>(options: {
          readonly message: string;
          readonly choices: ReadonlyArray<PromptChoice<A>>;
        }) => execute(Prompt.select(options), context),
        text: (message: string) => execute(Prompt.text({ message }), context),
        password: (message: string) =>
          execute(Prompt.password({ message }), context).pipe(Effect.map(Redacted.value)),
      };
    }),
  );
}

const execute = <A>(prompt: Prompt.Prompt<A>, context: Context.Context<Prompt.Environment>) =>
  Prompt.run(prompt).pipe(
    Effect.provide(context),
    Effect.catchTag("QuitError", () => Effect.interrupt),
  );
