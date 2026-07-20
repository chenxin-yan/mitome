import { Effect } from "effect";
import { Argument, CliError, Flag } from "effect/unstable/cli";

export const useFlag = Flag.string("use").pipe(
  Flag.withDescription("Path to an Agent Definition TypeScript entry file"),
  Flag.optional,
);

// Effect beta.98 ignores unconsumed positionals, so consume them all and
// validate cardinality inside the native argument parser.
export const noArguments = Argument.string("argument").pipe(
  Argument.variadic(),
  Argument.mapEffect((arguments_) =>
    arguments_.length === 0
      ? Effect.void
      : Effect.fail(
          new CliError.InvalidValue({
            option: "argument",
            value: arguments_[0]!,
            expected: "no additional arguments",
            kind: "argument",
          }),
        ),
  ),
);

export const missingUseFlag = Flag.boolean("__mitome-missing-use").pipe(
  Flag.withHidden,
  Flag.mapEffect((missing) =>
    missing ? Effect.fail(new CliError.MissingOption({ option: "use" })) : Effect.void,
  ),
);

export const promptArgument = Argument.string("prompt").pipe(
  Argument.variadic(),
  Argument.mapEffect((prompts) =>
    prompts.length === 1
      ? Effect.succeed(prompts[0]!)
      : prompts.length === 0
        ? Effect.fail(new CliError.MissingArgument({ argument: "prompt" }))
        : Effect.fail(
            new CliError.InvalidValue({
              option: "prompt",
              value: prompts[1]!,
              expected: "exactly one prompt",
              kind: "argument",
            }),
          ),
  ),
  Argument.withDescription("Prompt to send to the Agent"),
);
