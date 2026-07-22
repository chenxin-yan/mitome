import packageJson from "../package.json" with { type: "json" };

export type Flavor = "promise" | "effect";
export type Provider = "openai" | "openai-codex";

export interface ScaffoldOptions {
  readonly flavor: Flavor;
  readonly provider: Provider;
  readonly model: string;
}

export const agentDefinitionSource = ({ flavor, provider, model }: ScaffoldOptions): string => {
  const sdk = flavor === "effect" ? "@mitome/sdk/effect" : "@mitome/sdk";
  const providerImport =
    provider === "openai"
      ? 'import { env, openai } from "@mitome/providers/openai";'
      : 'import { codex } from "@mitome/providers/openai-codex";';
  const modelExpression =
    provider === "openai"
      ? `openai(${JSON.stringify(model)}, env("OPENAI_API_KEY"))`
      : `codex(${JSON.stringify(model)})`;
  return `import { defineAgent } from ${JSON.stringify(sdk)};\nimport { instructionFiles } from "@mitome/plugins";\n${providerImport}\n\nexport default defineAgent({\n  model: ${modelExpression},\n  plugins: [instructionFiles({ paths: ["./instructions.md"] })],\n});\n`;
};

export const instructionsSource = "You are a helpful Agent.\n";

export const agentPackageSource = (): string =>
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
