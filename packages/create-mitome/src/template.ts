import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };

export type Flavor = "promise" | "effect";
export type Provider = "openai" | "openai-codex";

export interface ScaffoldOptions {
  readonly flavor: Flavor;
  readonly provider: Provider;
  readonly model: string;
}

export type FileMap = ReadonlyMap<string, string>;

export interface Choice<A> {
  readonly label: string;
  readonly value: A;
}

export const providerChoices: ReadonlyArray<Choice<Provider>> = [
  { label: "OpenAI API", value: "openai" },
  { label: "OpenAI Codex (ChatGPT)", value: "openai-codex" },
];

export const customModel = Symbol("custom-model");

export const modelChoices = (
  knownModelIds: ReadonlyArray<string>,
): ReadonlyArray<Choice<string | typeof customModel>> => [
  ...knownModelIds.map((model) => ({ label: model, value: model })),
  { label: "Custom model ID", value: customModel },
];

export const validateModelId = (model: string): string | undefined => {
  const trimmed = model.trim();
  return trimmed === "" ? undefined : trimmed;
};

const definitionSource = (
  { flavor, provider, model }: ScaffoldOptions,
  instructionFilesOptions: string,
): string => {
  const sdk = flavor === "effect" ? "@mitome/sdk/effect" : "@mitome/sdk";
  const providerImport =
    provider === "openai"
      ? 'import { openai } from "@mitome/providers/openai";'
      : 'import { codex } from "@mitome/providers/openai-codex";';
  const providerFactory = provider === "openai" ? "openai()" : "codex()";
  return `import { defineAgent } from ${JSON.stringify(sdk)};\nimport { instructionFiles } from "@mitome/plugins";\n${providerImport}\n\nexport default defineAgent({\n  providers: [${providerFactory}],\n  model: ${JSON.stringify(`${provider}/${model}`)},\n  plugins: [instructionFiles(${instructionFilesOptions})],\n});\n`;
};

const agentDefinitionSource = (options: ScaffoldOptions): string =>
  definitionSource(options, '{ paths: ["./instructions.md"] }');

const defaultAgentDefinitionSource = (options: Omit<ScaffoldOptions, "flavor">): string =>
  definitionSource(
    { ...options, flavor: "promise" },
    '{ paths: ["./AGENTS.md"], discover: ["AGENTS.md"] }',
  );

const instructionsSource = "You are a helpful Agent.\n";

const agentPackageSource = (): string =>
  `${JSON.stringify(
    {
      name: "mitome-agent",
      private: true,
      type: "module",
      dependencies: {
        "@mitome/plugins": packageJson.version,
        "@mitome/providers": packageJson.version,
        "@mitome/sdk": packageJson.version,
      },
    },
    null,
    2,
  )}\n`;

const tsconfigSource = `${JSON.stringify(
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
)}\n`;

const readmeSource = (flavor: Flavor): string => {
  const embed =
    flavor === "promise"
      ? `import agent from "./index.js";\nimport { withSession } from "@mitome/sdk";\n\nawait withSession(agent, async (session) => {\n  for await (const event of session.prompt("Hi")) console.log(event);\n});`
      : `import { Effect, Stream } from "effect";\nimport agent from "./index.js";\nimport { createSession } from "@mitome/sdk/effect";\n\nawait Effect.runPromise(\n  Effect.scoped(\n    Effect.gen(function* () {\n      const session = yield* createSession(agent);\n      yield* Stream.runForEach(session.prompt("Hi"), (event) => Effect.log(event));\n    }),\n  ),\n);`;
  const effectInstall = flavor === "effect" ? "```sh\nnpm install effect\n```\n\n" : "";
  return `# Mitome Agent\n\n## Next steps\n\n\`\`\`sh\nnpm install\nnpm install -g @mitome/cli\nmitome auth login --use .\nmitome "hi" --use .\n\`\`\`\n\n## Embed the Agent\n\n${effectInstall}\`\`\`ts\n${embed}\n\`\`\`\n`;
};

// The file set is static; exported so the CLI can refuse a clobbered
// scaffold before prompting for plan options.
export const defaultAgentPlanFiles = ["index.ts", "AGENTS.md", "package.json"] as const;

export const defaultAgentPlan = (options: Omit<ScaffoldOptions, "flavor">): FileMap =>
  new Map([
    ["index.ts", defaultAgentDefinitionSource(options)],
    ["AGENTS.md", instructionsSource],
    ["package.json", agentPackageSource()],
  ]);

export const projectPlan = (options: ScaffoldOptions): FileMap =>
  new Map([
    ["package.json", agentPackageSource()],
    ["index.ts", agentDefinitionSource(options)],
    ["instructions.md", instructionsSource],
    ["tsconfig.json", tsconfigSource],
    ["README.md", readmeSource(options.flavor)],
  ]);

export const ensureEmpty = async (directory: string, files: Iterable<string>): Promise<void> => {
  for (const file of files) {
    const path = join(directory, file);
    try {
      await stat(path);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
    throw new Error(`${path} already exists`);
  }
};

export const writeScaffold = async (directory: string, plan: FileMap): Promise<void> => {
  await ensureEmpty(directory, plan.keys());

  await mkdir(directory, { recursive: true });
  await Promise.all(
    [...plan].map(([file, contents]) => writeFile(join(directory, file), contents)),
  );
};
