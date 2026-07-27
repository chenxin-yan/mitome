import { Argument, Flag } from "effect/unstable/cli";

export const useFlag = Flag.string("use").pipe(
  Flag.withDescription("Path to an Agent Definition module or directory"),
  Flag.optional,
);

export const promptArgument = Argument.string("prompt").pipe(
  Argument.withDescription("Prompt to send to the Agent"),
);
