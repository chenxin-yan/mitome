import { join } from "node:path";
import { Effect, Schema } from "effect";
import {
  defaultAgentPlan,
  defaultAgentPlanFiles,
  ensureEmpty,
  modelChoices,
  providerChoices,
  validateModelId,
  writeScaffold,
} from "create-mitome/template";
import { knownModelIds as codexModelIds } from "@mitome/providers/openai-codex";
import { knownModelIds as openAiModelIds } from "@mitome/providers/openai";
import { modelCatalog } from "../catalog.js";
import { ChildHost } from "../child-host-service.js";
import { requireConfigDirectory } from "../config.js";
import { Prompter } from "../prompter.js";
import { attempt, fail, type ExitCode } from "../support.js";
import { authenticateDefinition } from "./auth.js";

export const runInit = Effect.fn("@mitome/cli/runInit")(function* () {
  const childHost = yield* ChildHost;
  const prompter = yield* Prompter;
  const directory = yield* attempt(async () => requireConfigDirectory());
  const path = join(directory, "index.ts");
  // Fast-fail before prompting; writeScaffold still owns the ensure-empty
  // semantic for the actual write.
  yield* attempt(() => ensureEmpty(directory, defaultAgentPlanFiles));
  const provider = yield* prompter.select({
    message: "Provider",
    choices: providerChoices.map(({ label, value }) => ({ title: label, value })),
  });
  // models.dev only describes the OpenAI API; the Codex Provider has no
  // discovery source, so its hand-maintained hints are used directly.
  const knownModels =
    provider === "openai-codex"
      ? codexModelIds
      : yield* attempt(() => modelCatalog({ directory, fallback: openAiModelIds }));
  const modelChoice = yield* prompter.select({
    message: "Model",
    choices: modelChoices(knownModels).map(({ label, value }) => ({ title: label, value })),
  });
  let model: string | undefined;
  if (Schema.is(Schema.String)(modelChoice)) {
    model = modelChoice;
  } else {
    model = validateModelId(yield* prompter.text("Model ID"));
  }
  if (model === undefined) return yield* fail("Model ID is required.");
  yield* attempt(() => writeScaffold(directory, defaultAgentPlan({ provider, model })));
  const exitCode = yield* childHost.install(path);
  if (exitCode !== 0) return exitCode;
  yield* authenticateDefinition(path, "login");
  return 0 satisfies ExitCode;
});
