import { Layer } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { makeProvider } from "@mitome/core";
import { defineAgent, withSession } from "../src/index.js";

const layer = Layer.succeed(LanguageModel.LanguageModel, {} as LanguageModel.Service);
const first = makeProvider("first", ["known"] as const, undefined, () => layer);
const second = makeProvider("second", [] as const, undefined, () => layer);
const definition = defineAgent({
  providers: [first, second] as const,
  model: "first/known",
  extensions: [],
});

void withSession(definition, async (session) => {
  session.prompt("known", { model: "first/known" });
  session.prompt("private", { model: "second/private" });
  // @ts-expect-error Promise SDK selections must use a registered Provider prefix.
  session.prompt("invalid", { model: "missing/model" });
});
