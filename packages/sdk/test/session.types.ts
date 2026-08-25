import { Layer } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { makeProvider } from "@mitome/core";
import { defineAgent, withSession } from "../src/index.js";
import type { TranscriptStore } from "../src/index.js";

// SAFETY: This compile-only fixture is never executed; it only supplies the nominal service
// required to exercise Session's provider/model type constraints.
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

declare const store: TranscriptStore;
const transcript = { schemaVersion: 1 as const, id: "seed", messages: [] };
void withSession(definition, async () => undefined, { transcripts: store, resume: "seed" });
void withSession(definition, async () => undefined, { transcript });
// @ts-expect-error resume needs a TranscriptStore from which to load the seed.
void withSession(definition, async () => undefined, { resume: "seed" });
void withSession(definition, async () => undefined, {
  transcripts: store,
  resume: "seed",
  // @ts-expect-error direct Transcript seeds and stored resume identities are mutually exclusive.
  transcript,
});
