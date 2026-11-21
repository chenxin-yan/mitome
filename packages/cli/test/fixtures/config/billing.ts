// The Configuration's own Extension: one Tool whose every Call needs Approval.
import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { Extension } from "@mitome/core";
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
});
