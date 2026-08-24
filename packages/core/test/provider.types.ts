import { Layer } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { defineAgent, type QualifiedModelId, type Session } from "../src/index.js";
import * as Provider from "../src/provider.js";

// SAFETY: this compile-only fixture never executes the LanguageModel service.
const layer = Layer.succeed(LanguageModel.LanguageModel, {} as LanguageModel.Service);
const alpha = Provider.makeProvider("alpha", ["known", "other"] as const, undefined, () => layer);
const beta = Provider.makeProvider("beta", [] as const, undefined, () => layer);

// @ts-expect-error Provider ids must be non-empty.
Provider.makeProvider("", [], undefined, () => layer);
// @ts-expect-error Provider ids cannot contain the Model separator.
Provider.makeProvider("invalid/id", [], undefined, () => layer);

const definition = defineAgent({
  providers: [alpha, beta] as const,
  model: "alpha/known",
  extensions: [],
});

const known: QualifiedModelId<typeof alpha> = "alpha/known";
const arbitrary: QualifiedModelId<typeof alpha> = "alpha/private/fine-tune";
void known;
void arbitrary;

// @ts-expect-error Qualified Model ids must use a registered Provider prefix.
defineAgent({ providers: [alpha] as const, model: "beta/known", extensions: [] });

// @ts-expect-error Agent Definitions reject excess keys.
defineAgent({ providers: [alpha] as const, model: "alpha/known", extensions: [], extra: true });

// @ts-expect-error Every registered value must be a Provider.
defineAgent({
  providers: [alpha, "not-a-provider"] as const,
  model: "alpha/known",
  extensions: [],
});

const reordered = defineAgent({
  extensions: [],
  model: "beta/private",
  providers: [alpha, beta] as const,
});

declare const session: Session<readonly [typeof alpha, typeof beta]>;
void session.prompt("known", { model: "alpha/known" });
void session.prompt("arbitrary", { model: "beta/private" });
// @ts-expect-error Per-Turn selection must use a registered Provider prefix.
void session.prompt("invalid", { model: "missing/model" });

const defaultModel: "alpha/known" = definition.model;
const reorderedModel: "beta/private" = reordered.model;
void defaultModel;
void reorderedModel;
