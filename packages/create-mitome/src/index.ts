#!/usr/bin/env node

import { basename } from "node:path";
import { createInterface } from "node:readline";
import {
  customModel,
  modelChoices,
  projectPlan,
  providerChoices,
  type Choice,
  type ScaffoldOptions,
  validateModelId,
  writeScaffold,
} from "./template.js";

import { knownModelIds } from "./model-hints.js";

/** Exported for the CLI entry-point test. */
export const scaffold = (directory: string, options: ScaffoldOptions): Promise<void> =>
  writeScaffold(directory, projectPlan(options));

const choose = async <A>(
  question: (message: string) => Promise<string>,
  label: string,
  choices: ReadonlyArray<Choice<A>>,
): Promise<A> => {
  console.log(`${label}:`);
  choices.forEach((choice, index) =>
    console.log(`  ${index + 1}. ${choice.label}${index === 0 ? " (default)" : ""}`),
  );
  for (;;) {
    const answer = (await question("> ")).trim();
    const index = answer === "" ? 0 : Number(answer) - 1;
    const choice = choices[index];
    if (choice !== undefined) return choice.value;
    console.error(`Choose 1-${choices.length}.`);
  }
};

const main = async (): Promise<void> => {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const lines = terminal[Symbol.asyncIterator]();
  const question = async (message: string): Promise<string> => {
    process.stdout.write(message);
    const answer = await lines.next();
    if (answer.done) throw new Error("Input closed");
    return answer.value;
  };
  try {
    const provider = await choose(question, "Provider", providerChoices);
    const selectedModel = await choose(question, "Model", modelChoices(knownModelIds[provider]));
    const model =
      selectedModel === customModel ? validateModelId(await question("Model ID: ")) : selectedModel;
    if (model === undefined) throw new Error("Model ID is required");
    const flavor = await choose(question, "Template", [
      { label: "Promise-first", value: "promise" },
      { label: "Effect-native", value: "effect" },
    ] as const);
    const directory = process.cwd();
    await scaffold(directory, { flavor, provider, model });
    console.log(`Created a Mitome Agent in ${basename(directory)}.`);
  } finally {
    terminal.close();
  }
};

// import.meta.main is why engines declares node >=24.2 (added in 24.2.0).
if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
