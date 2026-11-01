import { Layer } from "effect";
import { LanguageModel } from "effect/ai";
import type { QualifiedModelId } from "../src/index.js";
import * as Provider from "../src/provider.js";

// SAFETY: this compile-only fixture never executes the LanguageModel service.
const layer = Layer.succeed(LanguageModel.LanguageModel, {} as LanguageModel.LanguageModel);
const alpha = Provider.makeProvider("alpha", ["known", "other"] as const, undefined, () => layer);

// @ts-expect-error Provider ids must be non-empty.
Provider.makeProvider("", [], undefined, () => layer);
// @ts-expect-error Provider ids cannot contain the Model separator.
Provider.makeProvider("invalid/id", [], undefined, () => layer);

const known: QualifiedModelId<typeof alpha> = "alpha/known";
const arbitrary: QualifiedModelId<typeof alpha> = "alpha/private/fine-tune";
void known;
void arbitrary;
