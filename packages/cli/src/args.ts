import { Effect } from "effect";
import { Argument, CliError, Flag, Param, Primitive } from "effect/unstable/cli";

export const useFlag = Flag.string("use").pipe(
  Flag.withDescription("Path to an Agent Definition module or directory"),
  Flag.optional,
);

// The parser silently ignores unconsumed positionals (still true on beta.101),
// so rejecting extras requires declaring an argument that accepts no values.
export const noArguments = Param.makeSingle({
  kind: Param.argumentKind,
  name: "argument",
  primitiveType: Primitive.none,
}).pipe(Param.optional);

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
