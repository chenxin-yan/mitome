import * as BunTerminal from "@effect/platform-bun/BunTerminal";
import { type Cause, Context, Effect, Layer, Queue, Redacted, Terminal } from "effect";
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
>()("@mitome/cli/Prompter") {}

const runPrompt = <A>(prompt: Prompt.Prompt<A>, context: Context.Context<Prompt.Environment>) =>
  Prompt.run(prompt).pipe(
    Effect.provide(context),
    Effect.catchTag("QuitError", () => Effect.interrupt),
  );

export const prompterLayer = Layer.effect(
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
    // The Bun terminal never ends its input queue at stdin EOF, so every prompt
    // after EOF waits forever. Ending the queue makes prompts fail with their
    // documented QuitError; buffered keypresses still deliver first.
    // TODO: delete this workaround once NodeTerminal ends its queue on stdin EOF (effect#4895).
    const promptTerminal = Terminal.make({
      ...terminal,
      readInput: terminal.readInput.pipe(
        Effect.tap((input) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const end = () => {
                stdinEnded = true;
                Queue.endUnsafe(input as Queue.Queue<Terminal.UserInput, Cause.Done>);
              };
              if (stdinEnded) end();
              else process.stdin.once("end", end);
              return end;
            }),
            (end) => Effect.sync(() => process.stdin.off("end", end)),
          ),
        ),
      ),
    });
    const context = Context.add(
      yield* Effect.context<Prompt.Environment>(),
      Terminal.Terminal,
      promptTerminal,
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
      }) => runPrompt(Prompt.select(options), context),
      text: (message: string) => runPrompt(Prompt.text({ message }), context),
      password: (message: string) =>
        runPrompt(Prompt.password({ message }), context).pipe(Effect.map(Redacted.value)),
    };
  }),
);
