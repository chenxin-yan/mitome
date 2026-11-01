/**
 * Scaffold plumbing behind the `create-mitome` executable. Not a supported API: it carries no
 * stability guarantee and may change in any release.
 *
 * @internal
 */
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };

export type Provider = "openai" | "openai-codex";

export interface ScaffoldOptions {
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

export const validateModelId = (model: string): string | undefined => model.trim() || undefined;

const programSource = ({ provider, model }: ScaffoldOptions): string => {
  const providerImport =
    provider === "openai"
      ? 'import { openai } from "@mitome/providers/openai";'
      : 'import { codex } from "@mitome/providers/openai-codex";';
  const providerFactory = provider === "openai" ? "openai()" : "codex()";
  return `import { Console, Effect } from "effect";
import { Prompt } from "effect/ai";
import { firstPartyExecutionLimits, loop, makeSession, providerModel, Turn } from "@mitome/core";
${providerImport}

// The Agent program: an ordinary Effect run as one Turn of a Session.
const agent = (message: string) =>
  Effect.gen(function* () {
    const turn = yield* Turn;
    yield* turn.stage(Prompt.userMessage({ content: [Prompt.textPart({ text: message })] }));
    const result = yield* loop({ instructions: "You are a helpful Agent." });
    return result.response.text;
  });

const main = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* makeSession({ persistence: "none", limits: firstPartyExecutionLimits });
    yield* Console.log(yield* session.run(agent("Hi")));
  }),
).pipe(Effect.provide(providerModel(${providerFactory}, ${JSON.stringify(model)})));

await Effect.runPromise(main);
`;
};

const agentPackageSource = (): string =>
  `${JSON.stringify(
    {
      name: "mitome-agent",
      private: true,
      type: "module",
      dependencies: {
        "@mitome/core": packageJson.version,
        "@mitome/providers": packageJson.version,
        effect: "4.0.0",
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
      // Effect's transitive declarations (msgpackr) reference Node globals; a fresh project
      // has no @types/node, so checking them would fail before any user code is reached.
      skipLibCheck: true,
    },
    include: ["**/*.ts"],
  },
  null,
  2,
)}\n`;

const gitignoreSource = "node_modules/\n";

// Runnable as written after `npm install`: `login` needs a config directory plus line I/O. The
// line iterator settles a pending read with `undefined` when stdin closes, as `login` requires;
// closing the interface lets the command exit when the browser callback wins instead.
const codexLogin = `node --input-type=module -e '
import { createInterface } from "node:readline";
import { configDirectory, configDirectoryMessage } from "@mitome/core";
import { login } from "@mitome/providers/openai-codex";
const directory = configDirectory();
if (directory === undefined) throw new Error(configDirectoryMessage);
const terminal = createInterface({ input: process.stdin });
const lines = terminal[Symbol.asyncIterator]();
try {
  await login({ configDirectory: directory, input: async () => (await lines.next()).value, output: console.log });
} finally {
  terminal.close();
}
'`;

const readmeSource = (provider: Provider): string => {
  const credential =
    provider === "openai"
      ? "Set `OPENAI_API_KEY`."
      : "Store a ChatGPT Codex Credential in Mitome's config directory with the login command below.";
  const login = provider === "openai" ? "" : `${codexLogin}\n`;
  return `# Mitome Agent\n\n## Next steps\n\n${credential}\n\n\`\`\`sh\nnpm install\n${login}node index.ts\n\`\`\`\n`;
};

export const projectPlan = (options: ScaffoldOptions): FileMap =>
  new Map([
    ["package.json", agentPackageSource()],
    ["index.ts", programSource(options)],
    ["tsconfig.json", tsconfigSource],
    [".gitignore", gitignoreSource],
    ["README.md", readmeSource(options.provider)],
  ]);

export const ensureEmpty = async (directory: string, files: Iterable<string>): Promise<void> => {
  for (const file of files) {
    const path = join(directory, file);
    const exists = await lstat(path).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (exists) throw new Error(`${path} already exists`);
  }
};

export const writeScaffold = async (directory: string, plan: FileMap): Promise<void> => {
  await ensureEmpty(directory, plan.keys());

  await mkdir(directory, { recursive: true });
  await Promise.all(
    [...plan].map(([file, contents]) => {
      const path = join(directory, file);
      // Exclusive creation is the guarantee; the preflight above is only the friendly diagnostic.
      return writeFile(path, contents, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
        throw error.code === "EEXIST" ? new Error(`${path} already exists`) : error;
      });
    }),
  );
};
