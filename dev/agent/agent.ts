import { Random, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { Agent, Extension } from "@mitome/core";

const Roll = Tool.make("roll", {
  description: "Roll a die with the given number of sides.",
  parameters: Schema.Struct({ sides: Schema.Int.check(Schema.isGreaterThan(1)) }),
  success: Schema.Int,
  needsApproval: true,
});
const DiceToolkit = Toolkit.make(Roll);

const dice = Extension.make("dice", {
  tools: DiceToolkit,
  handlers: DiceToolkit.of({ roll: ({ sides }) => Random.nextIntBetween(1, sides) }),
  instructions: "Use roll when the user asks for a random number.",
});

export const agent = Agent.make({
  instructions: "You are a helpful Agent.",
  use: [dice],
});
