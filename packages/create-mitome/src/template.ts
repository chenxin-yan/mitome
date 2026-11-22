/**
 * The pieces `create-mitome` and `mitome init` share: the questions both ask and the example Agent
 * both write. Not a supported API: it carries no stability guarantee and may change in any release.
 *
 * @internal
 */
import packageJson from "../package.json" with { type: "json" };
import { catalogVersions } from "./model-hints.js";

/** Generated Model hints per Provider, offered before the custom Model id escape. */
export { knownModelIds } from "./model-hints.js";

export type ProviderId = "openai" | "openai-codex" | "anthropic";

/** A first-party Provider as the prompt offers it and as generated source wires it in. */
export interface ProviderChoice {
  readonly id: ProviderId;
  readonly label: string;
  readonly import: string;
  readonly factory: string;
  /** The environment variable holding the API key; absent when the Provider signs in through its `login` instead. */
  readonly apiKeyEnv?: string;
  /** How a Provider without an API key signs in: the CLI command, or the import line of its `login` for an application. */
  readonly signIn?: { readonly command: string; readonly import: string };
}

/** The Providers offered, in prompt order; the first is the default. */
export const providerChoices: ReadonlyArray<ProviderChoice> = [
  {
    id: "openai",
    label: "OpenAI API",
    import: 'import { openai } from "@mitome/providers/openai";',
    factory: "openai()",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  {
    id: "openai-codex",
    label: "OpenAI Codex (ChatGPT)",
    import: 'import { codex } from "@mitome/providers/openai-codex";',
    factory: "codex()",
    signIn: {
      command: "mitome auth login --provider openai-codex",
      import: 'import { login } from "@mitome/providers/openai-codex";',
    },
  },
  {
    id: "anthropic",
    label: "Anthropic API",
    import: 'import { anthropic } from "@mitome/providers/anthropic";',
    factory: "anthropic()",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
];

export interface Choice<A> {
  readonly label: string;
  readonly value: A;
}

export const customModel = Symbol("custom-model");

export const modelChoices = (
  knownModelIds: ReadonlyArray<string>,
): ReadonlyArray<Choice<string | typeof customModel>> => [
  ...knownModelIds.map((model) => ({ label: model, value: model })),
  { label: "Custom model ID", value: customModel },
];

export const validateModelId = (model: string): string | undefined => model.trim() || undefined;

/** The dependencies a generated project pins: this release of Mitome and the Effect it is built on. */
export const pinnedDependencies = {
  "@mitome/core": packageJson.version,
  "@mitome/providers": packageJson.version,
  effect: catalogVersions.effect,
} as const;

/** The dev dependencies a generated project pins to type-check itself: the workspace's TypeScript and Node types. */
export const pinnedDevDependencies = {
  "@types/node": catalogVersions["@types/node"],
  typescript: catalogVersions.typescript,
} as const;

/**
 * The `.gitignore` both generators write. With `MITOME_HOME` pointed at a generated directory, a
 * Codex login writes its Credential there; the store writes it to `.auth-<pid>-<uuid>` before
 * renaming it to auth.json, and an abrupt stop can leave that plaintext file behind.
 */
export const gitignoreSource = "node_modules/\n/auth.json\n/auth.lock\n/.auth-*\n";

/** The example Agent's module (`agent.ts`): `export const agent`, with a `dice` Extension whose `roll` Tool needs Approval. */
export const exampleAgentSource = `import { Random, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { Agent, Extension } from "@mitome/core";

const Roll = Tool.make("roll", {
  description: "Roll a die with the given number of sides.",
  parameters: Schema.Struct({ sides: Schema.Int.check(Schema.isGreaterThan(1)) }),
  success: Schema.Int,
  needsApproval: true,
});
const DiceToolkit = Toolkit.make(Roll);

const dice = Extension.make("dice", {
  tools: DiceToolkit,
  handlers: DiceToolkit.of({ roll: ({ sides }) => Random.nextIntBetween(1, sides) }),
  instructions: "Use roll when the user asks for a random number.",
});

export const agent = Agent.make({
  instructions: "You are a helpful Agent.",
  use: [dice],
});
`;
