#!/usr/bin/env node

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import {
  agentDefinitionSource,
  agentPackageSource,
  instructionsSource,
  type Flavor,
  type ScaffoldOptions,
} from "./template.js";

import { knownModelIds } from "./model-hints.js";

const files = [
  "package.json",
  "index.ts",
  "instructions.md",
  "tsconfig.json",
  "README.md",
] as const;

const readme = (flavor: Flavor): string => {
  const embed =
    flavor === "promise"
      ? `import agent from "./index.js";\nimport { withSession } from "@mitome/sdk";\n\nawait withSession(agent, async (session) => {\n  for await (const event of session.prompt("Hi")) console.log(event);\n});`
      : `import { Effect, Stream } from "effect";\nimport agent from "./index.js";\nimport { createSession } from "@mitome/sdk/effect";\n\nawait Effect.runPromise(\n  Effect.scoped(\n    Effect.gen(function* () {\n      const session = yield* createSession(agent);\n      yield* Stream.runForEach(session.prompt("Hi"), (event) => Effect.log(event));\n    }),\n  ),\n);`;
  const effectInstall = flavor === "effect" ? "```sh\nnpm install effect\n```\n\n" : "";
  return `# Mitome Agent\n\n## Next steps\n\n\`\`\`sh\nnpm install\nnpm install -g @mitome/cli\nmitome auth login --use .\nmitome "hi" --use .\n\`\`\`\n\n## Embed the Agent\n\n${effectInstall}\`\`\`ts\n${embed}\n\`\`\`\n`;
};

export const scaffold = async (directory: string, options: ScaffoldOptions): Promise<void> => {
  for (const file of files) {
    if (existsSync(join(directory, file))) throw new Error(`${file} already exists`);
  }
  await Promise.all([
    writeFile(join(directory, "package.json"), agentPackageSource()),
    writeFile(join(directory, "index.ts"), agentDefinitionSource(options)),
    writeFile(join(directory, "instructions.md"), instructionsSource),
    writeFile(
      join(directory, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ESNext",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
          },
          include: ["index.ts"],
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(join(directory, "README.md"), readme(options.flavor)),
  ]);
};

type Choice<A> = { readonly label: string; readonly value: A };

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
    const provider = await choose(question, "Provider", [
      { label: "OpenAI API", value: "openai" },
      { label: "OpenAI Codex (ChatGPT)", value: "openai-codex" },
    ] as const);
    const customModel = Symbol("custom-model");
    const selectedModel = await choose<string | typeof customModel>(question, "Model", [
      ...knownModelIds[provider].map((model) => ({ label: model, value: model })),
      { label: "Custom model ID", value: customModel },
    ]);
    const model =
      selectedModel === customModel ? (await question("Model identifier: ")).trim() : selectedModel;
    if (model === "") throw new Error("Model identifier is required");
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
