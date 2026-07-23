import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Redacted } from "effect";
import { Prompt } from "effect/unstable/cli";
import {
  agentPackageSource,
  defaultAgentDefinitionSource,
  instructionsSource,
} from "create-mitome/template";
import { knownModelIds as codexModelIds } from "@mitome/providers/openai-codex";
import { knownModelIds as openAiModelIds } from "@mitome/providers/openai";
import { modelCatalog } from "../catalog.js";
import { install, runOAuthAuth } from "../child-host.js";
import { isEnoent, requireConfigDirectory, updateConfigEnv } from "../config.js";
import { attempt, fail, runNativePrompt, waitForChild } from "../support.js";

type InitProvider = "openai" | "openai-codex";
const customModel = Symbol("custom-model");

const initializationPath = async (): Promise<string> => {
  const directory = requireConfigDirectory();
  const path = join(directory, "agent.ts");
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
  await install(path);
};

export const runInit = Effect.gen(function* () {
  const path = yield* attempt(initializationPath);
  const provider = yield* runNativePrompt(
    Prompt.select<InitProvider>({
      message: "Provider",
      choices: [
        { title: "OpenAI API", value: "openai" },
        { title: "OpenAI Codex (ChatGPT)", value: "openai-codex" },
      ],
    }),
  );
  const catalog = yield* attempt(() =>
    modelCatalog({
      directory: dirname(path),
      fallback: { openai: openAiModelIds, "openai-codex": codexModelIds },
    }),
  );
  const knownModels = catalog[provider];
  const modelChoice = yield* runNativePrompt(
    Prompt.select<string | typeof customModel>({
      message: "Model",
      choices: [
        ...knownModels.map((model) => ({ title: model, value: model })),
        { title: "Custom model ID", value: customModel },
      ],
    }),
  );
  const model =
    modelChoice === customModel
      ? (yield* runNativePrompt(Prompt.text({ message: "Model identifier" }))).trim()
      : modelChoice;
  if (model === "") return yield* fail("Model identifier is required.");
  yield* waitForChild(() => initialize(path, provider, model));
  if (process.exitCode !== 0) return;
  if (provider === "openai-codex") {
    yield* waitForChild(() => runOAuthAuth(path, "login"));
    return;
  }
  const credential = Redacted.value(
    yield* runNativePrompt(Prompt.password({ message: "OpenAI API key" })),
  );
  if (credential === "") return yield* fail("Credential value is required.");
  yield* attempt(() => updateConfigEnv("OPENAI_API_KEY", credential));
});
