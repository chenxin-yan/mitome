import { lstat, mkdir, open, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  exampleAgentSource,
  gitignoreSource,
  pinnedDependencies,
  pinnedDevDependencies,
} from "./template.js";
import type { ProviderChoice } from "./template.js";

export interface ApplicationOptions {
  /** The package name, usually the directory's name. */
  readonly name: string;
  readonly provider: ProviderChoice;
  readonly model: string;
}

export type FileMap = ReadonlyMap<string, string>;

/** A directory name as an npm package name: lowercase and URL-safe, else `mitome-app`. */
export const packageName = (directory: string): string => {
  const name = directory
    .toLowerCase()
    .replaceAll(/[^a-z0-9._~-]+/g, "-")
    .replace(/^[._]+/, "");
  // npm rejects these although their characters are allowed.
  return name === "" || name.startsWith("-") || name === "node_modules" || name === "favicon.ico"
    ? "mitome-app"
    : name;
};

const packageSource = (name: string): string =>
  `${JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      scripts: { start: "node src/main.ts", check: "tsc" },
      dependencies: pinnedDependencies,
      devDependencies: pinnedDevDependencies,
      engines: { node: ">=24" },
    },
    null,
    2,
  )}\n`;

const mainSource = ({ provider, model }: ApplicationOptions): string =>
  `import { createInterface } from "node:readline";
import { Effect } from "effect";
import { type ApprovalDecision, Approver, type ApproverService, Provider, Session } from "@mitome/core";
${provider.import}
import { agent } from "./agent.ts";

const input = process.argv.slice(2).join(" ") || "Roll a six-sided die.";

// The application, not the Agent, decides who answers Approvals. With nobody at a terminal it
// provides no Approver, so a Tool Call that needs Approval is denied and the Model is told.
const askOn = (from: NodeJS.ReadableStream, to: NodeJS.WritableStream): ApproverService => ({
  decide: ({ name, params }) =>
    Effect.callback<ApprovalDecision>((resume) => {
      // The JSON the Model sent, which is what the Approval allows.
      const shown = JSON.stringify(params, null, 2);
      const terminal = createInterface({ input: from, output: to });
      // Input that ends (Ctrl-D) before an answer denies instead of leaving the Turn waiting.
      terminal.once("close", () => resume(Effect.succeed("deny")));
      terminal.question(\`Allow \${name} \${shown}? [y/N] \`, (answer) => {
        resume(Effect.succeed(answer.trim().toLowerCase() === "y" ? "allow" : "deny"));
        terminal.close();
      });
      return Effect.sync(() => terminal.close());
    }),
});

const turn = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* Session.make(agent);
    return yield* session.run(input);
  }),
);

// The question goes to stderr, so stdout carries only the result.
const program = (
  process.stdin.isTTY && process.stderr.isTTY
    ? Effect.provideService(turn, Approver, askOn(process.stdin, process.stderr))
    : turn
).pipe(Effect.provide(Provider.model(${provider.factory}, ${JSON.stringify(model)})));

Effect.runPromise(program).then(console.log, (error: unknown) => {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : error);
});
`;

const tsconfigSource = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ESNext",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      // Node runs the sources as written by stripping types: imports name `.ts` files, and only
      // syntax that strips away is allowed.
      allowImportingTsExtensions: true,
      erasableSyntaxOnly: true,
      verbatimModuleSyntax: true,
      types: ["node"],
    },
    include: ["src"],
  },
  null,
  2,
)}\n`;

// Runnable as written after `npm install`: `login` needs a state directory plus line I/O, and this
// program, an entry point, runs the Effect it returns. The line iterator settles a pending read
// with `undefined` when stdin closes, as `login` requires; closing the interface lets the command
// exit when the browser callback wins instead.
const loginStep = (signIn: { readonly import: string }) => `node --input-type=module -e '
import { createInterface } from "node:readline";
import { Effect } from "effect";
import { stateDirectory, stateDirectoryMessage } from "@mitome/core";
${signIn.import}
const directory = stateDirectory();
if (directory === undefined) throw new Error(stateDirectoryMessage);
const terminal = createInterface({ input: process.stdin });
const lines = terminal[Symbol.asyncIterator]();
const input = Effect.promise(async () => (await lines.next()).value);
try {
  await Effect.runPromise(login({ stateDirectory: directory, input, output: console.log }));
} finally {
  terminal.close();
}
'`;

const readmeSource = ({ name, provider, model }: ApplicationOptions): string => {
  const { id, apiKeyEnv, signIn, factory } = provider;
  const credential =
    signIn === undefined
      ? `Set \`${apiKeyEnv}\` to your API key.`
      : "import" in signIn
        ? `Sign in once: the \`node -e\` command below stores a Credential in Mitome's state directory (by default \`~/.local/state/mitome\`; \`MITOME_HOME\` moves it), where \`${factory}\` reads it. With the Mitome CLI, when its Configuration lists the \`${id}\` Provider, \`${signIn.command}\` stores the same Credential.`
        : `Set \`${apiKeyEnv}\` to your API key, or sign in once with \`${signIn.appCommand}\`, whose sign-in \`${factory}\` reads when \`${apiKeyEnv}\` is unset. With the Mitome CLI, when its Configuration lists the \`${id}\` Provider, \`${signIn.command}\` runs the same sign-in.`;
  const login = signIn !== undefined && "import" in signIn ? `${loginStep(signIn)}\n` : "";
  return `# ${name}

An application that embeds a Mitome Agent.

- \`src/agent.ts\` describes the Agent: its Instructions and the Extensions it uses. The \`dice\` Extension adds a \`roll\` Tool that needs Approval. It does not know how it is run.
- \`src/main.ts\` runs it: it opens a Session with the Model \`${model}\` (${provider.label}) and runs one Turn from the text on the command line. When a Tool Call needs Approval it asks on the terminal (\`y\`/\`n\`); without a terminal nobody is present, so the Tool Call is denied and the Model is told.

## Run it

${credential} Then, with Node.js 24 or later:

\`\`\`sh
npm install
${login}npm start -- "roll a die"
\`\`\`

\`npm run check\` type-checks the project.

## A terminal Agent instead

To chat with a personal Agent in the terminal rather than build an application, install the Mitome CLI (\`npm install -g @mitome/cli\`) and run \`mitome init\`: it writes a default Configuration that \`mitome\` opens.
`;
};

export const applicationPlan = (options: ApplicationOptions): FileMap =>
  new Map([
    ["package.json", packageSource(options.name)],
    ["src/agent.ts", exampleAgentSource],
    ["src/main.ts", mainSource(options)],
    ["tsconfig.json", tsconfigSource],
    [".gitignore", gitignoreSource],
    ["README.md", readmeSource(options)],
  ]);

const existing = (path: string) =>
  lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });

export const ensureEmpty = async (directory: string, files: Iterable<string>): Promise<void> => {
  const paths = [...files];
  // Exclusive creation guards a file, not its parent: a linked `src` would send it elsewhere.
  for (const parent of new Set(paths.map(dirname))) {
    const path = join(directory, parent);
    const stats = parent === "." ? undefined : await existing(path);
    if (stats !== undefined && !stats.isDirectory()) {
      throw new Error(`${path} is not a directory`);
    }
  }
  for (const file of paths) {
    const path = join(directory, file);
    if ((await existing(path)) !== undefined) {
      throw new Error(`${path} already exists`);
    }
  }
};

export const writeScaffold = async (directory: string, plan: FileMap): Promise<void> => {
  await ensureEmpty(directory, plan.keys());

  const createdFiles: Array<string> = [];
  const createdDirectories = new Set<string>();
  const writes = await Promise.allSettled(
    [...plan].map(async ([file, contents]) => {
      const path = join(directory, file);
      const firstCreated = await mkdir(dirname(path), { recursive: true });
      if (firstCreated !== undefined) {
        for (let parent = dirname(path); ; parent = dirname(parent)) {
          createdDirectories.add(parent);
          if (parent === firstCreated || parent === dirname(parent)) {
            break;
          }
        }
      }
      // Exclusive creation is the guarantee; the preflight above is only the friendly diagnostic.
      const handle = await open(path, "wx").catch((error: NodeJS.ErrnoException) => {
        throw error.code === "EEXIST" ? new Error(`${path} already exists`) : error;
      });
      // Recorded before the write, so a write that fails after the open (EFBIG) is undone too.
      createdFiles.push(path);
      try {
        await handle.writeFile(contents);
      } finally {
        await handle.close();
      }
    }),
  );
  const failed = writes.find((write) => write.status === "rejected");
  if (failed === undefined) {
    return;
  }
  // Undo only what this call made, so fixing the cause and running again finds nothing in the way.
  // Deepest directories first, so each is empty when it is removed.
  await Promise.allSettled(createdFiles.map((path) => unlink(path)));
  for (const path of [...createdDirectories].sort((left, right) => right.length - left.length)) {
    await rmdir(path).catch(() => undefined);
  }
  throw failed.reason;
};
