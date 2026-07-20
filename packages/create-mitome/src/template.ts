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
  return `import { defineAgent } from ${JSON.stringify(sdk)};\n${providerImport}\n\nexport default defineAgent({\n  instructions: "You are a helpful Agent.",\n  model: ${modelExpression},\n  plugins: [],\n});\n`;
};

export const agentPackageSource = (): string =>
  `${JSON.stringify(
    {
      name: "mitome-agent",
      private: true,
      type: "module",
      dependencies: {
        "@mitome/providers": packageJson.version,
        "@mitome/sdk": packageJson.version,
      },
    },
    null,
    2,
  )}\n`;
