import { Layer } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { makeProvider } from "@mitome/core";
import { defineAgent, withSession } from "../src/index.js";
import type { Prompt, PromptMessage, TranscriptStore } from "../src/index.js";

// SAFETY: This compile-only fixture is never executed; it only supplies the nominal service
// required to exercise Session's provider/model type constraints.
const layer = Layer.succeed(LanguageModel.LanguageModel, {} as LanguageModel.Service);
const first = makeProvider("first", ["known"] as const, undefined, () => layer);
const second = makeProvider("second", [] as const, undefined, () => layer);
const definition = defineAgent({
  providers: [first, second] as const,
  model: "first/known",
});
const noExtensions: readonly [] = definition.extensions;
void noExtensions;

void withSession(definition, async (session) => {
  const history: ReadonlyArray<PromptMessage> = session.history();
  void history;
  session.runTurn("known", { model: "first/known" });
  session.runTurn("private", { model: "second/private" });
  // @ts-expect-error Promise SDK selections must use a registered Provider prefix.
  session.runTurn("invalid", { model: "missing/model" });
});

declare const store: TranscriptStore;
const transcript = { schemaVersion: 1 as const, id: "seed", messages: [] };
void withSession(definition, { transcripts: store, resume: "seed" }, async () => undefined);
void withSession(definition, { transcript }, async () => undefined);
// @ts-expect-error resume needs a TranscriptStore from which to load the seed.
void withSession(definition, { resume: "seed" }, async () => undefined);
void withSession(
  definition,
  // @ts-expect-error direct Transcript seeds and stored resume identities are mutually exclusive.
  { transcripts: store, resume: "seed", transcript },
  async () => undefined,
);

const invalidUserPrompt = {
  content: [
    {
      role: "user",
      content: [{ type: "tool-result", id: "id", name: "tool", isFailure: false, result: null }],
    },
  ],
} as const;
// @ts-expect-error User Messages cannot contain Tool result parts.
const prompt: Prompt = invalidUserPrompt;
void prompt;
