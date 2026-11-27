// The Configuration's own Extension: one Tool whose every Call needs Approval, and a Command that
// answers the person without the Model.
import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { Command, Extension } from "@mitome/core";
import { record } from "../record.ts";

const Charge = Tool.make("charge", {
  parameters: Schema.Struct({ cents: Schema.FiniteFromString }),
  success: Schema.String,
  needsApproval: true,
});
const Kit = Toolkit.make(Charge);

export const billing = Extension.make("billing", {
  tools: Kit,
  handlers: Kit.of({
    charge: ({ cents }) => Effect.sync(() => (record(`charge:${cents}`), "charged")),
  }),
  commands: [
    Command.make("balance", {
      description: "Show what was charged",
      run: (input) =>
        Effect.sync(() => (record(`balance:${input}`), Command.reply("nothing charged yet"))),
    }),
  ],
});
