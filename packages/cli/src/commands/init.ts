import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import {
  agentPackageSource,
  defaultAgentDefinitionSource,
  instructionsSource,
} from "create-mitome/template";
import { knownModelIds as codexModelIds } from "@mitome/providers/openai-codex";
import { knownModelIds as openAiModelIds } from "@mitome/providers/openai";
import { modelCatalog } from "../catalog.js";
import { ChildHost } from "../child-host.js";
import { isEnoent, requireConfigDirectory } from "../config.js";
import { Prompter } from "../prompter.js";
import { attempt, fail, type ExitCode } from "../support.js";
import { authenticateDefinition } from "./auth.js";

type InitProvider = "openai" | "openai-codex";
const customModel = Symbol("custom-model");

const initializationPath = async (): Promise<string> => {
  const directory = requireConfigDirectory();
  const path = join(directory, "index.ts");
  for (const file of [path, join(directory, "AGENTS.md"), join(directory, "package.json")]) {
    const existing = await stat(file).catch((error: unknown) => {
      if (!isEnoent(error)) throw error;
      return undefined;
    });
    if (existing !== undefined) {
      throw new Error(
        `${file} already exists; remove it, or run mitome install and mitome auth login.`,
      );
    }
  }
  return path;
};

const initialize = async (path: string, provider: InitProvider, model: string): Promise<void> => {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  await writeFile(path, defaultAgentDefinitionSource({ provider, model }));
  await writeFile(join(directory, "AGENTS.md"), instructionsSource);
  await writeFile(join(directory, "package.json"), agentPackageSource());
};

export const runInit = Effect.gen(function* () {
  const childHost = yield* ChildHost;
  const prompter = yield* Prompter;
  const path = yield* attempt(initializationPath);
  const provider = yield* prompter.select<InitProvider>({
    message: "Provider",
    choices: [
      { title: "OpenAI API", value: "openai" },
      { title: "OpenAI Codex (ChatGPT)", value: "openai-codex" },
    ],
  });
  // models.dev only describes the OpenAI API; the Codex Provider has no
  // discovery source, so its hand-maintained hints are used directly.
  const knownModels =
    provider === "openai-codex"
      ? codexModelIds
      : yield* attempt(() => modelCatalog({ directory: dirname(path), fallback: openAiModelIds }));
  const modelChoice = yield* prompter.select<string | typeof customModel>({
    message: "Model",
    choices: [
      ...knownModels.map((model) => ({ title: model, value: model })),
      { title: "Custom model ID", value: customModel },
    ],
  });
  const model =
    modelChoice === customModel ? (yield* prompter.text("Model ID")).trim() : modelChoice;
  if (model === "") return yield* fail("Model ID is required.");
  yield* attempt(() => initialize(path, provider, model));
  const exitCode = yield* childHost.install(path);
  if (exitCode !== 0) return exitCode;
  yield* authenticateDefinition(path, "login");
  return 0 satisfies ExitCode;
});
