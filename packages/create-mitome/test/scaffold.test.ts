import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Effect, Fiber, Layer, Stream } from "effect";
import { LanguageModel } from "effect/ai";
import type { Prompt } from "effect/ai";
import { afterEach, describe, expect, test } from "vite-plus/test";
import packageJson from "../package.json" with { type: "json" };
import { Approver, Session, stateDirectoryMessage, withModelRequestAccounting } from "@mitome/core";
import type { Agent, ApprovalRequest, ApproverService } from "@mitome/core";
import { applicationPlan, packageName, writeScaffold } from "../src/application.js";
import {
  customModel,
  knownModelIds,
  modelChoices,
  pinnedDependencies,
  pinnedDevDependencies,
  providerChoices,
  validateModelId,
} from "../src/template.js";
import type { ProviderId } from "../src/template.js";

const directories: Array<string> = [];
const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), "create-mitome-"));
  directories.push(path);
  return path;
};

const packageDirectory = join(import.meta.dirname, "..");
const contents = (path: string, file: string) => readFile(join(path, file), "utf8");
const provider = (id: ProviderId) => providerChoices.find((choice) => choice.id === id)!;
const plan = (id: ProviderId, model: string) =>
  applicationPlan({ name: "my-app", provider: provider(id), model });
// What the workspace installed for this package, read independently of the generator.
const installed = async (name: string): Promise<string> =>
  JSON.parse(await readFile(join(packageDirectory, "node_modules", name, "package.json"), "utf8"))
    .version;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("application plans", () => {
  test("defines the Agent, the application that embeds it and project files as plan data", async () => {
    const openai = plan("openai", "gpt-5.6");

    expect([...openai.keys()]).toEqual([
      "package.json",
      "src/agent.ts",
      "src/main.ts",
      "tsconfig.json",
      ".gitignore",
      "README.md",
    ]);
    expect(openai.get("src/agent.ts")).toContain("export const agent = Agent.make({");
    expect(openai.get("src/agent.ts")).toContain("needsApproval: true,");
    expect(openai.get("src/main.ts")).toContain('import { agent } from "./agent.ts";');
    expect(openai.get("src/main.ts")).toContain(
      'import { openai } from "@mitome/providers/openai";',
    );
    expect(openai.get("src/main.ts")).toContain('Provider.model(openai(), "gpt-5.6")');
    expect(JSON.parse(openai.get("package.json")!)).toEqual({
      name: "my-app",
      private: true,
      type: "module",
      scripts: { start: "node src/main.ts", check: "tsc" },
      dependencies: {
        "@mitome/core": packageJson.version,
        "@mitome/providers": packageJson.version,
        effect: await installed("effect"),
      },
      devDependencies: {
        "@types/node": await installed("@types/node"),
        typescript: await installed("typescript"),
      },
      engines: { node: ">=24" },
    });
    // With MITOME_HOME pointed at the project, a Codex login writes its Credential files here.
    expect(openai.get(".gitignore")).toBe("node_modules/\n/auth.json\n/auth.lock\n/.auth-*\n");
    expect(openai.get("README.md")).toContain("# my-app\n");
    expect(openai.get("README.md")).toContain("`OPENAI_API_KEY`");
    expect(openai.get("README.md")).toContain('npm install\nnpm start -- "roll a die"\n');
    expect(openai.get("README.md")).toContain("`mitome init`");
    // Codex has no environment credential, so its README carries a runnable login step.
    const codexReadme = plan("openai-codex", "m").get("README.md")!;
    expect(codexReadme).toContain("npm install\nnode --input-type=module -e '");
    expect(codexReadme).toContain('import { login } from "@mitome/providers/openai-codex";');
    expect(codexReadme).toContain("`mitome auth login --provider openai-codex`");
    expect(codexReadme).not.toContain("OPENAI_API_KEY");
    // Anthropic takes an API key or reads the profile Anthropic's CLI signs in.
    const anthropicReadme = plan("anthropic", "claude-sonnet-5").get("README.md")!;
    expect(anthropicReadme).toContain("`ANTHROPIC_API_KEY`");
    expect(anthropicReadme).toContain("`ant auth login --profile=mitome`");
    expect(anthropicReadme).toContain("`mitome auth login --provider anthropic`");
    expect(anthropicReadme).toContain('npm install\nnpm start -- "roll a die"\n');
  });

  test("names the package after the directory, as npm accepts it", () => {
    expect(packageName("my-app")).toBe("my-app");
    expect(packageName("My Agent App")).toBe("my-agent-app");
    expect(packageName(".hidden")).toBe("hidden");
    expect(packageName("..")).toBe("mitome-app");
    // npm rejects a leading hyphen and reserved names.
    expect(packageName("@team")).toBe("mitome-app");
    expect(packageName("日本語")).toBe("mitome-app");
    expect(packageName("favicon.ico")).toBe("mitome-app");
    expect(packageName("node_modules")).toBe("mitome-app");
  });

  test("pins exact versions: the workspace's TypeScript and Node types for type-checking", async () => {
    expect(pinnedDevDependencies).toEqual({
      "@types/node": await installed("@types/node"),
      typescript: await installed("typescript"),
    });
    // A range would let two projects scaffolded by the same release install different packages.
    for (const version of Object.values({ ...pinnedDependencies, ...pinnedDevDependencies })) {
      expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    }
  });

  test("names an existing file before writing any scaffold file", async () => {
    const path = await directory();
    const existing = join(path, "src/main.ts");
    await mkdir(join(path, "src"));
    await writeFile(existing, "hand-written\n");

    await expect(writeScaffold(path, plan("openai", "gpt-5.6"))).rejects.toThrow(
      `${existing} already exists`,
    );
    expect(existsSync(join(path, "package.json"))).toBe(false);
    expect(await readFile(existing, "utf8")).toBe("hand-written\n");
  });

  test("refuses a dangling symlink instead of writing through it", async () => {
    const path = await directory();
    const link = join(path, "README.md");
    const target = join(path, "elsewhere.md");
    await symlink(target, link);

    await expect(writeScaffold(path, plan("openai", "gpt-5.6"))).rejects.toThrow(
      `${link} already exists`,
    );
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(target);
    expect(existsSync(target)).toBe(false);
  });

  test.each([
    ["a link to another directory", true],
    ["a dangling link", false],
  ])("refuses a src that is %s before writing anything", async (_name, targetExists) => {
    const path = await directory();
    const elsewhere = await directory();
    const target = join(elsewhere, "src");
    if (targetExists) {
      await mkdir(target);
    }
    await symlink(target, join(path, "src"), "dir");

    await expect(writeScaffold(path, plan("openai", "gpt-5.6"))).rejects.toThrow(
      `${join(path, "src")} is not a directory`,
    );
    expect(await readdir(path)).toEqual(["src"]);
    expect(await readdir(elsewhere)).toEqual(targetExists ? ["src"] : []);
    if (targetExists) {
      expect(await readdir(target)).toEqual([]);
    }
  });

  // Root writes through the mode, and Windows has no directory write bit.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "removes what it created when a write fails, so the scaffold can be retried",
    async () => {
      const path = await directory();
      await mkdir(join(path, "src"));
      await chmod(join(path, "src"), 0o555);

      await expect(writeScaffold(path, plan("openai", "gpt-5.6"))).rejects.toThrow("EACCES");
      expect(await readdir(path)).toEqual(["src"]);
      expect(await readdir(join(path, "src"))).toEqual([]);

      await chmod(join(path, "src"), 0o755);
      await writeScaffold(path, plan("openai", "gpt-5.6"));
      expect(await contents(path, "src/agent.ts")).toContain("export const agent");
    },
  );

  // A file-size limit lets the exclusive open create a file and then fails the write into it.
  test.skipIf(process.platform === "win32")(
    "removes a file it created when writing into it fails",
    { tags: ["dist"] },
    async () => {
      const path = await directory();
      const scaffold = pathToFileURL(join(packageDirectory, "dist/application.js")).href;
      const program = `const { writeScaffold } = await import(process.argv[1]);
await writeScaffold(process.argv[2], new Map(JSON.parse(process.argv[3]))).catch((error) => {
  process.stderr.write(error.code);
  process.exitCode = 1;
});`;
      const entries = JSON.stringify([...plan("openai", "gpt-5.6")]);
      const limited = [
        "-c",
        'ulimit -f 1 && exec "$0" "$@"',
        process.execPath,
        "--input-type=module",
      ];

      await expect(
        promisify(execFile)("sh", [...limited, "-e", program, scaffold, path, entries]),
      ).rejects.toMatchObject({ code: 1, stderr: "EFBIG" });
      expect(await readdir(path)).toEqual([]);

      await writeScaffold(path, plan("openai", "gpt-5.6"));
      expect(await contents(path, "README.md")).toBe(plan("openai", "gpt-5.6").get("README.md"));
    },
  );

  test("refuses a src that is a file", async () => {
    const path = await directory();
    await writeFile(join(path, "src"), "hand-written\n");

    await expect(writeScaffold(path, plan("openai", "gpt-5.6"))).rejects.toThrow(
      `${join(path, "src")} is not a directory`,
    );
    expect(await readdir(path)).toEqual(["src"]);
  });
});

describe("selection policy", () => {
  test("appends a custom-Model escape to known Model choices", () => {
    expect(modelChoices(["known-model"])).toEqual([
      { label: "known-model", value: "known-model" },
      { label: "Custom model ID", value: customModel },
    ]);
  });

  test("trims custom Model ids and rejects empty input", () => {
    expect(validateModelId("  private-model  ")).toBe("private-model");
    expect(validateModelId("   ")).toBeUndefined();
  });
});

describe("generated application", () => {
  // Stated here, not read from the generator's table, so a wrong factory or Model id fails.
  const variants = [
    ["openai", "gpt-5.6", 'Provider.model(openai(), "gpt-5.6")'],
    ["openai-codex", "gpt-5.6", 'Provider.model(codex(), "gpt-5.6")'],
    ["anthropic", "claude-sonnet-5", 'Provider.model(anthropic(), "claude-sonnet-5")'],
  ] as const;

  const generated = async () => {
    const root = await directory();
    // Generated projects resolve @mitome/core, @mitome/providers, effect, and @types/node like an
    // installed consumer would; this package's devDependencies stand in for the install.
    await symlink(join(packageDirectory, "node_modules"), join(root, "node_modules"), "dir");
    for (const [id, model] of variants) {
      await writeScaffold(join(root, id), plan(id, model));
    }
    return root;
  };

  const runNode = (cwd: string, args: ReadonlyArray<string>) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd,
        env: { HOME: cwd, MITOME_HOME: cwd, ANTHROPIC_CONFIG_DIR: cwd, PATH: "" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end();
    });

  test(
    "every Provider variant selects its Model and typechecks with its own tsconfig",
    { tags: ["dist"], timeout: 60_000 },
    async () => {
      const root = await generated();
      const tsc = promisify(execFile);
      await Promise.all(
        variants.map(async ([id, , model]) => {
          expect(await contents(join(root, id), "src/main.ts")).toContain(model);
          await expect(
            tsc(join(packageDirectory, "node_modules/.bin/tsc"), ["-p", join(root, id)]),
          ).resolves.toMatchObject({ stdout: "" });
        }),
      );
    },
  );

  test(
    "every Provider variant's main.ts exits with the Provider's missing-credential message",
    { tags: ["dist"], timeout: 60_000 },
    async () => {
      // Plain Node, as `npm start` runs it, with no credentials and an empty MITOME_HOME, HOME and
      // ANTHROPIC_CONFIG_DIR (so no Anthropic profile either), so the Provider stops before any
      // network request. stdin is a pipe, not a terminal.
      const credentials = {
        openai: "Environment variable OPENAI_API_KEY is not set or empty",
        "openai-codex": "Codex Credential is unavailable.",
        anthropic:
          "Environment variable ANTHROPIC_API_KEY is not set or empty. Set it to an API key, or sign in to the Claude Console",
      } as const;
      const root = await generated();
      for (const [id] of variants) {
        const result = await runNode(join(root, id), ["src/main.ts", "Roll a die."]);
        expect(result).toMatchObject({ code: 1, stdout: "" });
        expect(result.stderr).toContain(credentials[id]);
      }
    },
  );

  test(
    "main.ts reports a failure that is not an Error as a value",
    { tags: ["dist"], timeout: 15_000 },
    async () => {
      const project = join(await generated(), "openai");
      const main = await contents(project, "src/main.ts");
      const failing = main.replace(
        /^const program = [\s\S]+?;\n\n/m,
        'const program = Effect.fail(Object.assign(Object.create(null), { _tag: "Unavailable" }));\n\n',
      );
      expect(failing).not.toBe(main);
      await writeFile(join(project, "src/failing.ts"), failing);

      const result = await runNode(project, ["src/failing.ts"]);
      expect(result).toMatchObject({ code: 1, stdout: "" });
      expect(result.stderr).toContain("_tag: 'Unavailable'");
    },
  );

  test("main.ts asks on stderr, and only when stdin and stderr are terminals", async () => {
    const main = await contents(join(await generated(), "openai"), "src/main.ts");
    expect(main).toContain(
      "process.stdin.isTTY && process.stderr.isTTY\n    ? Effect.provideService(turn, Approver, askOn(process.stdin, process.stderr))",
    );
    expect(main).toContain("then(console.log,");
  });

  describe("the generated terminal Approver", () => {
    // The generated main.ts up to where it runs, so its `askOn` is exercised exactly as written.
    const generatedAskOn = async () => {
      const project = join(await generated(), "openai");
      const main = await contents(project, "src/main.ts");
      const path = join(project, "src/ask-on.ts");
      await writeFile(path, `${main.slice(0, main.indexOf("const turn ="))}export { askOn };\n`);
      const {
        askOn,
      }: {
        readonly askOn: (
          input: NodeJS.ReadableStream,
          output: NodeJS.WritableStream,
        ) => ApproverService;
      } = await import(pathToFileURL(path).href);
      return askOn;
    };
    const ask = (
      askOn: Awaited<ReturnType<typeof generatedAskOn>>,
      params: ApprovalRequest["params"],
    ) => {
      const input = new PassThrough();
      const output = new PassThrough().setEncoding("utf8");
      let shown = "";
      output.on("data", (chunk: string) => (shown += chunk));
      const fiber = Effect.runFork(
        askOn(input, output).decide({ turnId: "t1", toolCallId: "c1", name: "roll", params }),
      );
      return {
        input,
        fiber,
        shown: () => shown,
        reading: () => input.listenerCount("data") > 0,
      };
    };

    test("allows only on y, and denies when input ends while the question is open", async () => {
      const askOn = await generatedAskOn();

      const yes = ask(askOn, { sides: 6 });
      expect(yes.shown()).toBe('Allow roll {\n  "sides": 6\n}? [y/N] ');
      yes.input.write(" Y \n");
      expect(await Effect.runPromise(Fiber.join(yes.fiber))).toBe("allow");
      expect(yes.reading()).toBe(false);

      const no = ask(askOn, { sides: 6 });
      no.input.write("yes\n");
      expect(await Effect.runPromise(Fiber.join(no.fiber))).toBe("deny");

      const closed = ask(askOn, { sides: 6 });
      closed.input.end();
      expect(await Effect.runPromise(Fiber.join(closed.fiber))).toBe("deny");
      expect(closed.reading()).toBe(false);
    });

    test("stops reading when the Turn is interrupted", async () => {
      const pending = ask(await generatedAskOn(), { sides: 6 });
      expect(pending.reading()).toBe(true);

      await Effect.runPromise(Fiber.interrupt(pending.fiber));
      expect(pending.reading()).toBe(false);
    });

    test("shows the JSON the Model sent in full", async () => {
      const params = {
        sides: "6",
        list: Array.from({ length: 150 }, (_, index) => index),
        text: "x".repeat(20_000),
        deep: { a: { b: { c: { d: null } } } },
      };

      const shown = ask(await generatedAskOn(), params);
      shown.input.end();
      expect(await Effect.runPromise(Fiber.join(shown.fiber))).toBe("deny");
      expect(shown.shown()).toBe(`Allow roll ${JSON.stringify(params, null, 2)}? [y/N] `);
    });
  });

  test("the generated Agent asks for Approval to roll: denied with nobody, run when allowed", async () => {
    const root = await generated();
    // The generated agent.ts imports the same workspace `@mitome/core` as this test, so its brand holds;
    // like `Agent.Agent`, it maps text to text and needs nothing but a Model.
    const { agent }: { readonly agent: Agent.Agent } = await import(
      pathToFileURL(join(root, "openai", "src/agent.ts")).href
    );
    expect(agent.use?.map((extension: { readonly name: string }) => extension.name)).toEqual([
      "dice",
    ]);
    const finish = (reason: "tool-calls" | "stop") =>
      ({ type: "finish", reason, usage: { inputTokens: {}, outputTokens: {} } }) as const;
    const turn = (approver: Layer.Layer<never>) => {
      const prompts: Array<Prompt.Prompt> = [];
      const script = [
        [{ type: "tool-call", id: "c1", name: "roll", params: { sides: 6 } }, finish("tool-calls")],
        [{ type: "text", text: "rolled" }, finish("stop")],
      ] as const;
      const model = withModelRequestAccounting(
        "scripted",
        Layer.effect(
          LanguageModel.LanguageModel,
          LanguageModel.make({
            generateText: (options) =>
              Effect.sync(() => [...script[prompts.push(options.prompt) - 1]!]),
            streamText: () => Stream.die(new Error("not streamed")),
          }),
        ),
      );
      return Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* Session.make(agent);
            return yield* session.run("Roll a die.");
          }),
        ).pipe(Effect.provide(Layer.merge(model, approver))),
      ).then((result) => ({
        result,
        told: JSON.stringify(prompts[1]),
        rolled: prompts[1]?.content.at(-1),
      }));
    };

    const alone = await turn(Layer.empty);
    expect(alone.result).toBe("rolled");
    expect(alone.told).toContain("Tool call needs approval and nobody is present to give it");

    const asked: Array<ApprovalRequest> = [];
    const allowed = await turn(
      Layer.succeed(Approver, {
        decide: (request) => Effect.sync(() => (asked.push(request), "allow" as const)),
      }),
    );
    expect(allowed.result).toBe("rolled");
    expect(asked).toMatchObject([{ toolCallId: "c1", name: "roll", params: { sides: 6 } }]);
    expect(allowed.told).not.toContain("Tool call");
    expect(allowed.rolled).toMatchObject({
      role: "tool",
      content: [
        { type: "tool-result", name: "roll", isFailure: false, result: expect.any(Number) },
      ],
    });
  });
});

describe("generated Codex login step", { tags: ["dist"] }, () => {
  // The README's `node -e` program, run like a user would from a project with the packages
  // installed (this package's node_modules stand in for the install). PATH is empty, so no browser
  // opens; the flow falls back to the printed URL and pasted redirect.
  const loginProgram = () => {
    const readme = plan("openai-codex", "m").get("README.md")!;
    return readme.slice(readme.indexOf("-e '") + 4, readme.indexOf("\n'\n"));
  };
  const runLogin = (env: Record<string, string>, closeAtPrompt: boolean, cwd = packageDirectory) =>
    new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", loginProgram()], {
        cwd,
        env: { PATH: "", ...env },
      });
      // An external bound, so a lost prompt or a login left waiting fails this test instead of
      // leaving the child and its callback listener behind.
      const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      let stdout = "";
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
        // A pipe keeps no write boundaries, so the prompt can arrive across chunks.
        if (
          closeAtPrompt &&
          !child.stdin.writableEnded &&
          stdout.includes("Paste the redirect URL")
        ) {
          child.stdin.end();
        }
      });
      child.on("close", (code) => {
        clearTimeout(killer);
        resolve({ code, stderr });
      });
    });

  test("ends login when stdin closes while the redirect prompt is pending", async () => {
    const result = await runLogin({ MITOME_HOME: await directory() }, true);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("OAuth input closed.");
  }, 15_000);

  test("exits once the browser callback wins, while stdin is still open", async () => {
    // Only `login` is stubbed: it checks it was given the state directory, starts the pasted-URL
    // read, then succeeds as a callback would, interrupting the read.
    const project = await directory();
    const state = join(project, "state");
    const providers = join(project, "node_modules/@mitome/providers");
    await mkdir(providers, { recursive: true });
    for (const name of ["@mitome/core", "effect"]) {
      await symlink(
        join(packageDirectory, "node_modules", name),
        join(project, "node_modules", name),
        "dir",
      );
    }
    await writeFile(
      join(providers, "package.json"),
      JSON.stringify({
        name: "@mitome/providers",
        type: "module",
        exports: { "./openai-codex": "./codex.js" },
      }),
    );
    await writeFile(
      join(providers, "codex.js"),
      `import { Effect } from "effect";\nexport const login = ({ stateDirectory, input }) => stateDirectory === ${JSON.stringify(join(state, "mitome"))} ? Effect.raceFirst(input, Effect.sleep(50)) : Effect.fail(new Error(\`login got \${stateDirectory}\`));\n`,
    );
    const result = await runLogin(
      { XDG_CONFIG_HOME: join(project, "config"), XDG_STATE_HOME: state },
      false,
      project,
    );
    expect(result).toEqual({ code: 0, stderr: "" });
  }, 15_000);

  test("names the state-directory remedy when no state root is set", async () => {
    const result = await runLogin({}, false);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(stateDirectoryMessage);
  }, 15_000);
});

describe("create-mitome executable", { tags: ["dist"] }, () => {
  const executable = join(packageDirectory, "dist/index.js");
  const run = (args: ReadonlyArray<string>, input: string, cwd: string) =>
    new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [executable, ...args], { cwd });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
      child.stdin.end(input);
    });
  const customModelChoice = (provider: keyof typeof knownModelIds) =>
    knownModelIds[provider].length + 1;

  test("scaffolds the numbered selections into the directory argument", async () => {
    const path = await directory();

    const result = await run(["My App"], "2\n1\n", path);

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("Created a Mitome application in My App.");
    const application = join(path, "My App");
    expect(JSON.parse(await contents(application, "package.json"))).toMatchObject({
      name: "my-app",
    });
    expect(await contents(application, "src/main.ts")).toContain(
      `Provider.model(codex(), ${JSON.stringify(knownModelIds["openai-codex"][0])})`,
    );
  });

  test("accepts a trimmed custom Model id", async () => {
    const path = await directory();

    const result = await run([], `1\n${customModelChoice("openai")}\n  my-model  \n`, path);

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(await contents(path, "src/main.ts")).toContain('Provider.model(openai(), "my-model")');
  });

  test("defaults empty answers and re-asks after an out-of-range choice", async () => {
    const path = await directory();

    const result = await run([], "9\n\n\n", path);

    expect(result).toMatchObject({ exitCode: 0, stderr: "Choose 1-3.\n" });
    expect(await contents(path, "src/main.ts")).toContain(
      `Provider.model(openai(), ${JSON.stringify(knownModelIds.openai[0])})`,
    );
  });

  test.each([
    ["closed input", "1\n", "Input closed"],
    ["blank custom Model id", `1\n${customModelChoice("openai")}\n   \n`, "Model ID is required"],
  ])("fails with exit code 1 and writes nothing on %s", async (_name, input, message) => {
    const path = await directory();

    const result = await run([], input, path);

    expect(result).toMatchObject({ exitCode: 1, stderr: `${message}\n` });
    expect(existsSync(join(path, "package.json"))).toBe(false);
  });
});
