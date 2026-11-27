import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import { LanguageModel, Prompt, type Response, Tool, Toolkit } from "effect/ai";
import {
  Agent,
  Approver,
  Command,
  CommandFailedError,
  CommandNotFoundError,
  ExecutionLimitError,
  Extension,
  Mitome,
  Session,
  SessionReleasedError,
  Turn,
  withModelRequestAccounting,
} from "../../src/index.js";
import { Session as KernelSession } from "../../src/kernel.js";
import { call, finish, text } from "../support/step.js";

/** A scripted Model that records every Prompt it is sent. */
const recording = (
  script: Array<ReadonlyArray<Response.PartEncoded>>,
  prompts: Array<Prompt.Prompt>,
) =>
  withModelRequestAccounting(
    "recording",
    Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: (options) =>
          Effect.suspend(() => {
            prompts.push(options.prompt);
            const next = script.shift();
            return next === undefined
              ? Effect.die(new Error("script exhausted"))
              : Effect.succeed([...next]);
          }),
        streamText: () => Stream.die(new Error("not streamed")),
      }),
    ),
  );

const system = (prompt: Prompt.Prompt | undefined) => {
  const first = prompt?.content[0];
  return first?.role === "system" ? first.content : undefined;
};

const user = (value: string) =>
  Effect.gen(function* () {
    const turn = yield* Turn;
    yield* turn.stage(Prompt.userMessage({ content: [Prompt.textPart({ text: value })] }));
  });

const keyed = <const Name extends string>(name: Name, needsApproval = false) =>
  Tool.make(name, {
    parameters: Schema.Struct({ key: Schema.String }),
    success: Schema.String,
    needsApproval,
  });

/** An Extension with one Tool whose handler logs `<name>:<key>`. */
const logging = <R = never>(
  name: string,
  tool: string,
  log: Array<string>,
  options: Pick<Extension.Parts<{}, R>, "instructions" | "policy"> = {},
) => {
  const kit = Toolkit.make(keyed(tool));
  return Extension.make(name, {
    ...options,
    tools: kit,
    handlers: {
      [tool]: ({ key }: { readonly key: string }) =>
        Effect.sync(() => (log.push(`${tool}:${key}`), key)),
    },
  });
};

/** The record an Extension given as a record keeps. */
const record = <Tools extends Record<string, Tool.Any>, E, R>(
  extension: Extension.Extension<Tools, E, R>,
) => {
  if (Effect.isEffect(extension.parts)) {
    throw new Error("not a record");
  }
  return extension.parts;
};

/** A Command that replies with `text`. */
const replying = (name: string, text: string) =>
  Command.make(name, {
    description: `Reply ${text}`,
    run: () => Effect.succeed(Command.reply(text)),
  });

/** The defect a construction died with. */
const defect = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

describe("Extension.make", () => {
  it("returns its name and a frozen copy of the record, frozen and branded", () => {
    const extension = Extension.make("notes", { instructions: "Keep notes." });
    expect(Object.keys(extension)).toEqual(["name", "parts"]);
    expect(Object.isFrozen(extension)).toBe(true);
    expect(Object.isFrozen(extension.parts)).toBe(true);
    expect({ ...extension }).toEqual({ name: "notes", parts: { instructions: "Keep notes." } });
  });

  it("keeps a setup as given and runs nothing", () => {
    const log: Array<string> = [];
    const setup = Effect.sync(() => (log.push("setup"), { instructions: "Keep notes." }));
    const extension = Extension.make("notes", setup);
    expect(Object.keys(extension)).toEqual(["name", "parts"]);
    expect(extension.parts).toBe(setup);
    expect(log).toEqual([]);
  });

  it("keeps a field the record inherits, such as a class's deny policy", () => {
    class Strict {
      policy(this: void) {
        return Effect.succeed("deny" as const);
      }
    }
    expect(record(Extension.make("strict", new Strict())).policy).toBe(Strict.prototype.policy);
  });

  it("keeps its own copies of the handler map and the Command list", () => {
    const kit = Toolkit.make(keyed("add"));
    const add = ({ key }: { readonly key: string }) => Effect.succeed(key);
    const handlers = { add };
    const todos = replying("todos", "none");
    const commands = [todos];
    const extension = Extension.make("notes", { tools: kit, handlers, commands });
    handlers.add = () => Effect.succeed("replaced");
    commands.push(replying("plan", "later"));
    expect(record(extension).handlers).toEqual({ add });
    expect(Object.isFrozen(record(extension).handlers)).toBe(true);
    expect(record(extension).commands).toEqual([todos]);
    expect(Object.isFrozen(record(extension).commands)).toBe(true);
  });

  it("rejects invalid fields", () => {
    const kit = Toolkit.make(keyed("add"));
    expect(() => Extension.make("", {})).toThrow("non-empty string");
    expect(() => Extension.make("notes", { tools: kit })).toThrow(
      'Extension "notes" must give handlers exactly when it gives tools',
    );
    expect(() => Extension.make("notes", { handlers: {} })).toThrow("exactly when it gives tools");
    // SAFETY: deliberately mistyped, so the runtime check sees what the types would reject.
    expect(() => Extension.make("notes", { layer: Layer.empty } as never)).toThrow(
      'Extension "notes" has no field "layer"',
    );
    // SAFETY: deliberately mistyped, so the runtime check sees what the types would reject.
    expect(() => Extension.make("notes", { policy: "ask" as never })).toThrow(
      "policy must be a function",
    );
    const misspelt = { instructions: "Keep notes.", instruction: "typo" };
    expect(() => Extension.make("notes", misspelt)).toThrow(
      'Extension "notes" has no field "instruction"',
    );
    // SAFETY: deliberately mistyped, so the runtime check sees what the types would reject.
    expect(() => Extension.make("notes", { commands: [{ name: "todos" }] as never })).toThrow(
      'Extension "notes" commands must be a list of Commands made by Command.make',
    );
    expect(() =>
      Extension.make("notes", { commands: [replying("todos", "a"), replying("todos", "b")] }),
    ).toThrow('Extension "notes" has two Commands named "todos"');
  });

  it("checks the Toolkit and the handler map against it", () => {
    const kit = Toolkit.make(keyed("add"));
    const add = ({ key }: { readonly key: string }) => Effect.succeed(key);
    // SAFETY: deliberately mistyped; the shape of a Toolkit without being one.
    const fake = { tools: kit.tools } as typeof kit;
    expect(() => Extension.make("notes", { tools: fake, handlers: { add } })).toThrow(
      'Extension "notes" tools must be a Toolkit',
    );
    // SAFETY: deliberately mistyped, so the runtime check sees what the types would reject.
    const missing = {} as Toolkit.HandlersFrom<Toolkit.Tools<typeof kit>>;
    expect(() => Extension.make("notes", { tools: kit, handlers: missing })).toThrow(
      `Extension "notes" handlers must match its Toolkit's Tools exactly`,
    );
    const extra = { add, remove: add };
    expect(() => Extension.make("notes", { tools: kit, handlers: extra })).toThrow(
      `Extension "notes" handlers must match its Toolkit's Tools exactly`,
    );
    // SAFETY: deliberately mistyped; a handler that cannot be called.
    const uncallable = { add: 42 } as never;
    expect(() => Extension.make("notes", { tools: kit, handlers: uncallable })).toThrow(
      'Extension "notes" handler "add" must be a function',
    );
    // SAFETY: deliberately mistyped; handlers built by an Effect are not a handler map.
    const built = Effect.succeed({ add }) as never;
    expect(() => Extension.make("notes", { tools: kit, handlers: built })).toThrow(
      'Extension "notes" handlers must be a handler map',
    );
  });
});

describe("Command", () => {
  it("make returns its name, description and run, frozen and branded", () => {
    const run = () => Effect.succeed(Command.reply("nothing yet"));
    const todos = Command.make("todos", { description: "Show the todo list", run });
    expect({ ...todos }).toEqual({ name: "todos", description: "Show the todo list", run });
    expect(Object.isFrozen(todos)).toBe(true);
    // The types cannot tell a spread copy from the Command; only the brand can.
    expect(() => Extension.make("notes", { commands: [{ ...todos }] })).toThrow(
      "commands must be a list of Commands made by Command.make",
    );
  });

  it("make rejects an invalid name or description", () => {
    const run = () => Effect.succeed(Command.reply(""));
    for (const name of ["", "Todos", "1todos", "to-dos", "_todos", `t${"o".repeat(31)}`]) {
      expect(() => Command.make(name, { description: "Show", run })).toThrow(
        `Command name "${name}" must be a lowercase letter followed by at most 30 lowercase letters, digits or underscores`,
      );
    }
    expect(Command.make(`t${"o".repeat(30)}`, { description: "Show", run }).name).toHaveLength(31);
    for (const description of [
      "",
      "two\nlines",
      "two\rlines",
      "two\u0085lines",
      "two\u2028lines",
      "two\u2029lines",
      "x".repeat(101),
    ]) {
      expect(() => Command.make("todos", { description, run })).toThrow(
        'Command "todos" description must be one non-empty line of at most 100 characters',
      );
    }
    expect(Command.make("todos", { description: "x".repeat(100), run }).description).toHaveLength(
      100,
    );
    // SAFETY: deliberately mistyped, so the runtime check sees what the types would reject.
    expect(() => Command.make("todos", { description: "Show", run: "x" as never })).toThrow(
      'Command "todos" run must be a function',
    );
    const misspelt = { description: "Show", run, desc: "typo" };
    expect(() => Command.make("todos", misspelt)).toThrow('Command "todos" has no field "desc"');
  });

  it("reply and prompt are the two results, holding their text", () => {
    expect(Command.reply("shown")).toEqual({ _tag: "Reply", text: "shown" });
    expect(Command.prompt("plan this")).toEqual({ _tag: "Prompt", text: "plan this" });
  });

  it("parse finds a Command only at the very start, ended by whitespace or the end", () => {
    expect(Command.parse("/todos")).toEqual({ name: "todos", input: "" });
    expect(Command.parse("/todos   ")).toEqual({ name: "todos", input: "" });
    expect(Command.parse("/plan  the release \n now ")).toEqual({
      name: "plan",
      input: "the release \n now ",
    });
    expect(Command.parse("/plan\nthe release")).toEqual({ name: "plan", input: "the release" });
    expect(Command.parse(`/t${"o".repeat(30)} x`)).toEqual({
      name: `t${"o".repeat(30)}`,
      input: "x",
    });
    for (const text of [
      "/etc/passwd",
      " /todos",
      "/",
      "/Todos",
      "todos",
      "/to-dos",
      "/todos!",
      `/t${"o".repeat(31)}`,
      "",
    ]) {
      expect(Command.parse(text)).toBeUndefined();
    }
  });
});

describe("Agent.make", () => {
  it("returns exactly the given fields, frozen, with its own copies of `use` and `limits`", () => {
    const notes = Extension.make("notes", {});
    const use = [notes];
    const limits = { generations: 1, dispatches: 0 };
    const agent = Agent.make({ instructions: "Be brief.", use, limits });
    use.length = 0;
    limits.dispatches = 10;
    expect(Object.keys(agent)).toEqual(["instructions", "use", "limits"]);
    expect(Object.isFrozen(agent)).toBe(true);
    expect(agent.use).toEqual([notes]);
    expect(Object.isFrozen(agent.use)).toBe(true);
    expect(agent.limits).toEqual({ generations: 1, dispatches: 0 });
    expect(Object.isFrozen(agent.limits)).toBe(true);
    // A bound left out is no limit, and the copy has no key for it.
    expect(Object.keys(Agent.make({ limits: { generations: 1 } }).limits ?? {})).toEqual([
      "generations",
    ]);
  });

  it("keeps the `use` and `limits` it checked, reading each once", () => {
    let reads = 0;
    const limits = {
      get generations() {
        return reads++ === 0 ? 1 : -1;
      },
      dispatches: 1,
    };
    expect(Agent.make({ limits }).limits).toEqual({ generations: 1, dispatches: 1 });
    // A bound is read by name, so one that is inherited or behind a class's getter counts.
    expect(Agent.make({ limits: Object.create({ generations: 0 }) }).limits).toEqual({
      generations: 0,
    });
    const gettered = new (class {
      get dispatches() {
        return 0;
      }
    })();
    expect(Agent.make({ limits: gettered }).limits).toEqual({ dispatches: 0 });
    const notes = Extension.make("notes", {});
    const use = [notes];
    // Iterating yields an unchecked copy, while indexing yields the Extension.
    Object.defineProperty(use, Symbol.iterator, {
      value: function* () {
        yield { ...notes };
      },
    });
    expect(() => Agent.make({ use })).toThrow(
      "Agent use[0] is not an Extension made by Extension.make",
    );
  });

  it("keeps a field the options inherit, such as a class's program", () => {
    class Shout {
      program(this: void, input: string) {
        return Effect.succeed(input.toUpperCase());
      }
    }
    expect(Agent.make(new Shout()).program).toBe(Shout.prototype.program);
  });

  it("rejects invalid fields, Extensions copied without make and duplicate names", () => {
    const log: Array<string> = [];
    const notes = Extension.make("notes", {});
    // The types cannot tell a spread copy from the Extension; only the brand can.
    expect(() => Agent.make({ use: [{ ...notes }] })).toThrow(
      "Agent use[0] is not an Extension made by Extension.make",
    );
    // SAFETY: deliberately mistyped, so the runtime check sees what the types would reject.
    expect(() => Agent.make({ program: "loop" as never })).toThrow("program must be a function");
    // SAFETY: deliberately mistyped, so the runtime check sees what the types would reject.
    expect(() => Agent.make({ text: { parse: Effect.succeed } as never })).toThrow(
      "text must have parse and render functions",
    );
    const misspelt = { instructions: "Be brief.", instruction: "typo" };
    expect(() => Agent.make(misspelt)).toThrow('Agent has no field "instruction"');
    expect(() => Agent.make({ use: [notes, Extension.make("notes", Effect.succeed({}))] })).toThrow(
      'Two Extensions are named "notes"',
    );
    expect(() =>
      Agent.make({ use: [logging("notes", "save", log), logging("files", "save", log)] }),
    ).toThrow('Tool "save" is defined by both Extension "notes" and Extension "files"');
    expect(() =>
      Agent.make({
        use: [
          Extension.make("notes", { commands: [replying("todos", "notes")] }),
          Extension.make("files", { commands: [replying("todos", "files")] }),
        ],
      }),
    ).toThrow('Command "todos" is defined by both Extension "notes" and Extension "files"');
  });

  it("finds a Tool clash by Tool name, whatever key a Toolkit holds the Tool under", () => {
    const log: Array<string> = [];
    const kit = Toolkit.make(keyed("save"));
    // SAFETY: deliberately mistyped; a Toolkit, assembled as Effect assembles one, holding the
    // Tool "save" under the key "store".
    const renamed = Object.assign(function () {}, kit, {
      tools: { store: kit.tools.save },
    }) as never;
    const files = Extension.make("files", {
      tools: renamed,
      handlers: { store: () => Effect.succeed("") },
    });
    expect(() => Agent.make({ use: [logging("notes", "save", log), files] })).toThrow(
      'Tool "save" is defined by both Extension "notes" and Extension "files"',
    );
  });

  it("rejects limits that are not non-negative integers before anything is built", () => {
    const log: Array<string> = [];
    const built = Extension.make(
      "built",
      Effect.sync(() => (log.push("built"), {})),
    );
    for (const limits of [
      { generations: -1, dispatches: 1 },
      { generations: 1, dispatches: 1.5 },
      { generations: 1, dispatches: Number.POSITIVE_INFINITY },
      { dispatches: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => Agent.make({ use: [built], limits })).toThrow(
        "Agent limits must be non-negative integers",
      );
    }
    // A misspelled bound would otherwise be dropped, leaving that count without a limit.
    const misspelled = { generations: 1, dispatch: 0 };
    expect(() => Agent.make({ use: [built], limits: misspelled })).toThrow(
      'Agent limits have no bound "dispatch"',
    );
    expect(log).toEqual([]);
  });

  it("recognises only the values Extension.make and Agent.make returned", () => {
    const notes = Extension.make("notes", {});
    expect(() => Agent.make({ use: [Object.create(notes)] })).toThrow(
      "Agent use[0] is not an Extension made by Extension.make",
    );
    const agent = Agent.make({ use: [notes] });
    expect(() => Mitome.make({ agent: Object.create(agent) })).toThrow(
      "Mitome.make expects an Agent made by Agent.make",
    );
  });
});

describe("Session.make(agent)", () => {
  it.effect("runs an Agent without limits past 64 generations, and an Agent's limits bind", () =>
    Effect.gen(function* () {
      const steps = (count: number) =>
        Agent.make({
          program: (_: string, { step }) =>
            Effect.gen(function* () {
              for (let i = 0; i < count; i++) {
                yield* step;
              }
              return "";
            }),
        });
      const answers = () => Array.from({ length: 65 }, () => [text("ok")]);
      const run = (agent: ReturnType<typeof steps>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* Session.make(agent);
            return yield* Effect.exit(
              session.run("go").pipe(Effect.provide(recording(answers(), []))),
            );
          }),
        );
      expect(Exit.isSuccess(yield* run(steps(65)))).toBe(true);
      const limited = Agent.make({ ...steps(2), limits: { generations: 1 } });
      expect(yield* run(limited)).toEqual(
        Exit.fail(new ExecutionLimitError({ limit: "generations", bound: 1 })),
      );
    }),
  );

  it.effect("merges Instructions in order and the Tools of every Extension", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const prompts: Array<Prompt.Prompt> = [];
      const agent = Agent.make({
        instructions: "You help.",
        use: [
          logging("notes", "save", log, { instructions: "Keep notes." }),
          Extension.make("quiet", {}),
          logging("files", "read", log, { instructions: "Read files." }),
        ],
      });
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make(agent);
          return yield* session.run("go").pipe(
            Effect.provide(
              recording(
                [
                  [call("c1", "save", "a"), call("c2", "read", "b"), finish("tool-calls")],
                  [text("done"), finish("stop")],
                ],
                prompts,
              ),
            ),
          );
        }),
      );
      expect(result).toBe("done");
      expect(log).toEqual(["save:a", "read:b"]);
      expect(system(prompts[0])).toBe("You help.\n\nKeep notes.\n\nRead files.");
    }),
  );

  it.effect("lets an Extension policy tighten the Agent's decision but never loosen it", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const seen: Array<string> = [];
      const prompts: Array<Prompt.Prompt> = [];
      const agent = Agent.make({
        use: [
          logging("strict", "alpha", log, {
            // It sees calls to Tools it does not own, and tries to allow everything else.
            policy: (call) =>
              Effect.sync(() => (seen.push(call.name), call.name === "alpha" ? "deny" : "allow")),
          }),
          logging("other", "beta", log),
        ],
        policy: (call) => Effect.succeed(call.name === "alpha" ? "allow" : "ask"),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make(agent);
          yield* session.run("go").pipe(
            Effect.provide(
              recording(
                [
                  [call("c1", "alpha", "a"), call("c2", "beta", "b"), finish("tool-calls")],
                  [text("done"), finish("stop")],
                ],
                prompts,
              ),
            ),
          );
        }),
      );
      expect(seen).toEqual(["alpha", "beta"]);
      expect(log).toEqual([]);
      const told = JSON.stringify(prompts[1]);
      expect(told).toContain("Tool call was denied by policy");
      expect(told).toContain("Tool call needs approval and nobody is present to give it");
    }),
  );

  it.effect(
    "adds the same Tools, Instructions and policy whether given as a record or a setup",
    () =>
      Effect.gen(function* () {
        const kit = Toolkit.make(keyed("save"), keyed("remove"));
        const parts = (log: Array<string>) => ({
          instructions: "Keep notes.",
          tools: kit,
          handlers: kit.of({
            save: ({ key }) => Effect.sync(() => (log.push(`save:${key}`), key)),
            remove: ({ key }) => Effect.sync(() => (log.push(`remove:${key}`), key)),
          }),
          policy: (call: Extension.ToolCall) =>
            Effect.succeed(call.name === "remove" ? ("deny" as const) : ("allow" as const)),
        });
        const observe = (
          notes: (log: Array<string>) => Extension.Extension<Toolkit.Tools<typeof kit>>,
        ) =>
          Effect.gen(function* () {
            const log: Array<string> = [];
            const prompts: Array<Prompt.Prompt> = [];
            const result = yield* Effect.scoped(
              Effect.gen(function* () {
                const session = yield* Session.make(
                  Agent.make({ instructions: "You help.", use: [notes(log)] }),
                );
                return yield* session.run("go").pipe(
                  Effect.provide(
                    recording(
                      [
                        [call("c1", "save", "a"), call("c2", "remove", "b"), finish("tool-calls")],
                        [text("done"), finish("stop")],
                      ],
                      prompts,
                    ),
                  ),
                );
              }),
            );
            return { result, log, prompts };
          });
        const fromRecord = yield* observe((log) => Extension.make("notes", parts(log)));
        const fromSetup = yield* observe((log) =>
          Extension.make(
            "notes",
            Effect.sync(() => parts(log)),
          ),
        );
        expect(fromRecord.result).toBe("done");
        expect(fromRecord.log).toEqual(["save:a"]);
        expect(system(fromRecord.prompts[0])).toBe("You help.\n\nKeep notes.");
        expect(fromRecord.prompts[0]?.content.some((message) => message.role === "system")).toBe(
          true,
        );
        expect(JSON.stringify(fromRecord.prompts[1])).toContain("Tool call was denied by policy");
        expect(fromSetup).toEqual(fromRecord);
      }),
  );

  it.effect("keeps `use` order for Instructions with records and setups mixed", () =>
    Effect.gen(function* () {
      const prompts: Array<Prompt.Prompt> = [];
      const agent = Agent.make({
        instructions: "You help.",
        use: [
          Extension.make(
            "slow",
            Effect.as(Effect.andThen(Effect.yieldNow, Effect.yieldNow), { instructions: "First." }),
          ),
          Extension.make("plain", { instructions: "Second." }),
          Extension.make("quick", Effect.succeed({ instructions: "Third." })),
        ],
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make(agent);
          yield* session
            .run("go")
            .pipe(Effect.provide(recording([[text("done"), finish("stop")]], prompts)));
        }),
      );
      expect(system(prompts[0])).toBe("You help.\n\nFirst.\n\nSecond.\n\nThird.");
    }),
  );

  it.effect("runs a setup once per Session and releases what it acquired after the Session", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      let built = 0;
      const counter = Extension.make(
        "counter",
        Effect.gen(function* () {
          const id = yield* Effect.acquireRelease(
            Effect.sync(() => ++built),
            (id) => Effect.sync(() => void log.push(`release:${id}`)),
          );
          return { commands: [replying("id", `${id}`)] };
        }),
      );
      const started = yield* Deferred.make<void>();
      const agent = Agent.make({
        use: [counter],
        program: (input: string) =>
          Effect.gen(function* () {
            if (input === "hold") {
              yield* Effect.addFinalizer(() => Effect.sync(() => void log.push("turn")));
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }
            return input;
          }),
      });
      // A parallel caller Scope still releases the Session before what its setup acquired.
      const scope = yield* Scope.make("parallel");
      const first = yield* Session.make(agent).pipe(Scope.provide(scope));
      expect(yield* first.command("id", "")).toEqual(Command.reply("1"));
      expect(yield* first.command("id", "")).toEqual(Command.reply("1"));
      const second = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make(agent);
          return yield* session.command("id", "");
        }),
      );
      expect(second).toEqual(Command.reply("2"));
      expect(log).toEqual(["release:2"]);

      const held = yield* Effect.forkChild(first.run("hold"));
      yield* Deferred.await(started);
      yield* Scope.close(scope, Exit.void);
      // The active Turn drained before what the setup acquired was released.
      expect(log).toEqual(["release:2", "turn", "release:1"]);
      expect(Exit.hasInterrupts(yield* Fiber.await(held))).toBe(true);
      expect(built).toBe(2);
    }),
  );

  it.effect("gives each Session its own setup state, which its Tools and Commands share", () =>
    Effect.gen(function* () {
      const TodoKit = Toolkit.make(keyed("todo_add"));
      const todo = Extension.make(
        "todo",
        Effect.gen(function* () {
          const todos = yield* Ref.make<ReadonlyArray<string>>([]);
          return {
            tools: TodoKit,
            handlers: TodoKit.of({
              todo_add: ({ key }) =>
                Effect.as(
                  Ref.update(todos, (list) => [...list, key]),
                  "added",
                ),
            }),
            commands: [
              Command.make("todos", {
                description: "Show the todo list",
                run: () =>
                  Effect.map(Ref.get(todos), (list) => Command.reply(list.join(", ") || "none")),
              }),
            ],
          };
        }),
      );
      const agent = Agent.make({ use: [todo] });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const one = yield* Session.make(agent);
          const two = yield* Session.make(agent);
          yield* one.run("add").pipe(
            Effect.provide(
              recording(
                [
                  [call("c1", "todo_add", "write tests"), finish("tool-calls")],
                  [text("done"), finish("stop")],
                ],
                [],
              ),
            ),
          );
          expect(yield* one.command("todos", "")).toEqual(Command.reply("write tests"));
          expect(yield* two.command("todos", "")).toEqual(Command.reply("none"));
        }),
      );
    }),
  );

  it.effect(
    "runs a policy with its Step's services, those Session.make had replacing the same ones, and a Command with what Session.make had",
    () =>
      Effect.gen(function* () {
        class Rules extends Context.Service<Rules, { readonly allowed: string }>()("test/Rules") {}
        const log: Array<string> = [];
        const prompts: Array<Prompt.Prompt> = [];
        const ruled = logging("ruled", "save", log, {
          policy: (call) =>
            Effect.map(Rules, ({ allowed }) => (call.name === allowed ? "allow" : "deny")),
        });
        const telling = Extension.make("telling", {
          commands: [
            Command.make("rules", {
              description: "Show the rules",
              run: () => Effect.map(Rules, ({ allowed }) => Command.reply(allowed)),
            }),
          ],
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* Session.make(Agent.make({ use: [ruled, telling] })).pipe(
              Effect.provideService(Rules, { allowed: "save" }),
            );
            expect(yield* session.command("rules", "")).toEqual(Command.reply("save"));
            yield* session.run("go").pipe(
              Effect.provide(
                recording(
                  [
                    [call("c1", "save", "a"), finish("tool-calls")],
                    [text("done"), finish("stop")],
                  ],
                  prompts,
                ),
              ),
              Effect.provideService(Rules, { allowed: "nothing" }),
            );
          }),
        );
        expect(log).toEqual(["save:a"]);
      }),
  );

  it.effect("lets a policy see a service its Session was made without but its Step has", () =>
    Effect.gen(function* () {
      class Flag extends Context.Service<Flag, { readonly on: boolean }>()("test/Flag") {}
      const seen: Array<string> = [];
      const flagged = logging("flagged", "save", [], {
        policy: () =>
          Effect.map(Effect.serviceOption(Flag), (flag) => {
            seen.push(Option.isSome(flag) ? "flag" : "no flag");
            return "allow" as const;
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make(Agent.make({ use: [flagged] }));
          yield* session.run("go").pipe(
            Effect.provide(
              recording(
                [
                  [call("c1", "save", "a"), finish("tool-calls")],
                  [text("done"), finish("stop")],
                ],
                [],
              ),
            ),
            Effect.provideService(Flag, { on: true }),
          );
        }),
      );
      expect(seen).toEqual(["flag"]);
    }),
  );

  it.effect("releases what earlier setups acquired when a setup fails, with its failure", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const acquiring = Extension.make(
        "acquiring",
        Effect.as(
          Effect.acquireRelease(
            // Yields first, so a setup run beside it rather than after it would start sooner.
            Effect.andThen(
              Effect.yieldNow,
              Effect.sync(() => void log.push("acquired")),
            ),
            (_, exit) => Effect.sync(() => void log.push(`release:${exit._tag}`)),
          ),
          {},
        ),
      );
      const broken = Extension.make(
        "broken",
        Effect.andThen(
          Effect.sync(() => void log.push("broken")),
          Effect.fail("no setup"),
        ),
      );
      const never = Extension.make(
        "never",
        Effect.sync(() => (log.push("never"), {})),
      );
      const scope = yield* Scope.make();
      const failure = yield* Effect.flip(
        Session.make(Agent.make({ use: [acquiring, broken, never] })).pipe(Scope.provide(scope)),
      );
      expect(failure).toBe("no setup");
      expect(log).toEqual(["acquired", "broken", "release:Failure"]);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("reports a construction failure as a defect when releasing what it built dies", () =>
    Effect.gen(function* () {
      const cleanup = new Error("release");
      const dying = Extension.make(
        "dying",
        Effect.as(
          Effect.acquireRelease(Effect.void, () => Effect.die(cleanup)),
          {},
        ),
      );
      const broken = Extension.make("broken", Effect.fail("no setup"));
      const exit = yield* Effect.exit(
        Effect.scoped(Session.make(Agent.make({ use: [dying, broken] }))),
      );
      // A Cause that contains a defect keeps no typed failure: the construction failure is one too.
      const reasons = Exit.isFailure(exit) ? exit.cause.reasons : [];
      expect(reasons.map((reason) => (Cause.isDieReason(reason) ? reason.defect : reason))).toEqual(
        ["no setup", cleanup],
      );
    }),
  );

  it.effect("fails with a defect naming the Extension when a setup's record is malformed", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const kit = Toolkit.make(keyed("save"));
      const acquiring = Extension.make(
        "acquiring",
        Effect.as(
          Effect.acquireRelease(Effect.void, () => Effect.sync(() => void log.push("released"))),
          {},
        ),
      );
      const malformed = [
        // SAFETY: deliberately mistyped, so the runtime check sees what the types would reject.
        [
          Effect.succeed({ instruction: "typo" } as never),
          'Extension "bad" has no field "instruction"',
        ],
        [
          Effect.succeed({ tools: kit }),
          'Extension "bad" must give handlers exactly when it gives tools',
        ],
        // SAFETY: deliberately mistyped, so the runtime check sees what the types would reject.
        [Effect.succeed("notes" as never), 'Extension "bad" must add a record'],
        [
          // SAFETY: deliberately mistyped; handlers for a Tool the Toolkit lacks.
          Effect.succeed({
            tools: kit,
            handlers: { save: () => Effect.succeed(""), load: () => Effect.succeed("") } as never,
          }),
          `Extension "bad" handlers must match its Toolkit's Tools exactly`,
        ],
        [
          Effect.succeed({ commands: [replying("todos", "a"), replying("todos", "b")] }),
          'Extension "bad" has two Commands named "todos"',
        ],
        [
          // SAFETY: deliberately mistyped; a handler that cannot be called.
          Effect.succeed({ tools: kit, handlers: { save: 42 } as never }),
          'Extension "bad" handler "save" must be a function',
        ],
      ] as const;
      for (const [setup, message] of malformed) {
        const exit = yield* Effect.exit(
          Effect.scoped(
            Session.make(Agent.make({ use: [acquiring, Extension.make("bad", setup)] })),
          ),
        );
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
        expect(defect(exit)).toEqual(new TypeError(message));
      }
      expect(log).toEqual(Array.from(malformed, () => "released"));
    }),
  );

  it.effect("fails with a defect naming both Extensions when a setup's record clashes", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const fromSetup = (name: string, parts: Extension.Parts) =>
        Extension.make(name, Effect.succeed(parts));
      const saving = record(logging("notes", "save", log));
      const clashes = [
        [
          [logging("notes", "save", log), fromSetup("files", saving)],
          'Tool "save" is defined by both Extension "notes" and Extension "files"',
        ],
        [
          [fromSetup("notes", saving), logging("files", "save", log)],
          'Tool "save" is defined by both Extension "notes" and Extension "files"',
        ],
        [
          [
            Extension.make("notes", { commands: [replying("todos", "notes")] }),
            fromSetup("files", { commands: [replying("todos", "files")] }),
          ],
          'Command "todos" is defined by both Extension "notes" and Extension "files"',
        ],
      ] as const;
      for (const [use, message] of clashes) {
        const exit = yield* Effect.exit(Effect.scoped(Session.make(Agent.make({ use }))));
        expect(defect(exit)).toEqual(new TypeError(message));
      }
    }),
  );

  it.effect(
    "never lets a setup, handler, policy or Command reach the Approver or a Turn's own",
    () =>
      Effect.gen(function* () {
        const seen: Array<string> = [];
        const log: Array<string> = [];
        const see = (where: string) =>
          Effect.gen(function* () {
            const approver = yield* Approver;
            const turn = yield* Effect.serviceOption(Turn);
            seen.push(
              `${where}:${approver === undefined ? "nobody" : "somebody"}:${Option.isNone(turn) ? "no turn" : "turn"}`,
            );
          });
        const kit = Toolkit.make(keyed("remove", true));
        const guarded = Extension.make(
          "guarded",
          Effect.as(see("setup"), {
            tools: kit,
            handlers: kit.of({
              remove: ({ key }) => Effect.as(see("handler"), (log.push(key), key)),
            }),
            policy: () => Effect.as(see("policy"), "ask" as const),
            commands: [
              Command.make("look", {
                description: "Look around",
                run: () => Effect.as(see("command"), Command.reply("")),
              }),
            ],
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const outer = yield* Effect.scope;
            const kernel = yield* KernelSession.make({
              transcript: "none",
              limits: { generations: 0, dispatches: 0 },
            });
            // Made, and a Command run, inside another Session's Turn, which no Extension code sees.
            const session = yield* kernel.run(
              Session.make(Agent.make({ use: [guarded] })).pipe(Scope.provide(outer)),
            );
            yield* kernel.run(session.command("look", ""));
            yield* session.run("go").pipe(
              Effect.provide(
                recording(
                  [
                    [call("c1", "remove", "a"), finish("tool-calls")],
                    [text("done"), finish("stop")],
                  ],
                  [],
                ),
              ),
            );
          }),
        ).pipe(Effect.provideService(Approver, { decide: () => Effect.succeed("allow") }));
        // The Host's Approver still answered the Turn's request.
        expect(log).toEqual(["a"]);
        expect(seen).toEqual([
          "setup:nobody:no turn",
          "command:nobody:no turn",
          "policy:nobody:turn",
          "handler:nobody:turn",
        ]);
      }),
  );

  it.effect("lets no Extension bind another Extension's Tool", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const prompts: Array<Prompt.Prompt> = [];
      const filesKit = Toolkit.make(keyed("read"));
      const read = ({ key }: { readonly key: string }) => Effect.succeed(key);
      // Returned by a setup, so only the run can see what the map holds.
      const thief = Extension.make(
        "files",
        Effect.succeed({
          tools: filesKit,
          handlers: {
            read,
            // SAFETY: deliberately mistyped; a binding for the notes Extension's Tool.
            ...({ save: () => Effect.sync(() => (log.push("stolen"), "")) } as {}),
          },
        }),
      );
      const exit = yield* Effect.exit(
        Effect.scoped(Session.make(Agent.make({ use: [logging("notes", "save", log), thief] }))),
      );
      expect(defect(exit)).toEqual(
        new TypeError(`Extension "files" handlers must match its Toolkit's Tools exactly`),
      );

      // With its own binding only, the notes Extension's handler is the one that runs, even when a
      // later setup adds a binding to a map already checked.
      const checked = { read };
      const files = Extension.make("files", { tools: filesKit, handlers: checked });
      const writeKit = Toolkit.make(keyed("write"));
      const meddler = Extension.make(
        "meddler",
        Effect.sync(() => {
          // A binding for the notes Extension's Tool, added after the files map was checked.
          Object.assign(checked, { save: () => Effect.sync(() => (log.push("stolen"), "")) });
          return {
            tools: writeKit,
            handlers: writeKit.of({ write: ({ key }) => Effect.succeed(key) }),
          };
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make(
            Agent.make({ use: [logging("notes", "save", log), files, meddler] }),
          );
          yield* session.run("go").pipe(
            Effect.provide(
              recording(
                [
                  [call("c1", "save", "a"), finish("tool-calls")],
                  [text("done"), finish("stop")],
                ],
                prompts,
              ),
            ),
          );
        }),
      );
      expect(log).toEqual(["save:a"]);
    }),
  );

  it.effect("gives a policy the Scope its Step runs in, not the setup's", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const scoped = Extension.make(
        "scoped",
        Effect.as(
          Effect.addFinalizer(() => Effect.sync(() => void log.push("setup finalized"))),
          {
            policy: () =>
              Effect.as(
                Effect.addFinalizer(() => Effect.sync(() => void log.push("policy finalized"))),
                "allow" as const,
              ),
          },
        ),
      );
      const agent = Agent.make({
        use: [scoped, logging("notes", "save", log)],
        program: (input: string, { step }) =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Effect.sync(() => void log.push("program finalized")));
            yield* user(input);
            yield* step;
            return input;
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make(agent);
          yield* session
            .run("go")
            .pipe(Effect.provide(recording([[call("c1", "save", "a"), finish("tool-calls")]], [])));
          log.push("returned");
        }),
      );
      expect(log).toEqual([
        "save:a",
        "policy finalized",
        "program finalized",
        "returned",
        "setup finalized",
      ]);
    }),
  );

  it.effect("answers with the Model the caller of run provides, not the one setups had", () =>
    Effect.gen(function* () {
      const fromRun: Array<Prompt.Prompt> = [];
      const fromMake: Array<Prompt.Prompt> = [];
      const answer = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make(
            Agent.make({ use: [Extension.make("quiet", Effect.succeed({}))] }),
          ).pipe(Effect.provide(recording([[text("make"), finish("stop")]], fromMake)));
          return yield* session
            .run("go")
            .pipe(Effect.provide(recording([[text("run"), finish("stop")]], fromRun)));
        }),
      );
      expect(answer).toBe("run");
      expect(fromRun).toHaveLength(1);
      expect(fromMake).toEqual([]);
    }),
  );

  it.effect("lists its Extensions' Commands in `use` order and runs one by name", () =>
    Effect.gen(function* () {
      const failure = new Error("unreachable");
      const bug = new Error("bug");
      const agent = Agent.make({
        use: [
          Extension.make(
            "planning",
            Effect.succeed({
              commands: [
                Command.make("plan", {
                  description: "Plan the work",
                  run: (input) => Effect.succeed(Command.prompt(`Plan this: ${input}`)),
                }),
              ],
            }),
          ),
          Extension.make("quiet", {}),
          Extension.make("notes", {
            commands: [
              replying("todos", "none"),
              Command.make("fail", { description: "Fail", run: () => Effect.fail(failure) }),
              Command.make("bug", { description: "Die", run: () => Effect.die(bug) }),
            ],
          }),
        ],
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make(agent);
          expect(session.commands).toEqual([
            { name: "plan", description: "Plan the work", extension: "planning" },
            { name: "todos", description: "Reply none", extension: "notes" },
            { name: "fail", description: "Fail", extension: "notes" },
            { name: "bug", description: "Die", extension: "notes" },
          ]);
          expect(Object.isFrozen(session.commands)).toBe(true);
          expect(yield* session.command("plan", "the release")).toEqual(
            Command.prompt("Plan this: the release"),
          );
          expect(yield* session.command("todos", "")).toEqual(Command.reply("none"));
          const missing = yield* Effect.flip(session.command("nope", ""));
          expect(missing).toEqual(new CommandNotFoundError({ command: "nope" }));
          expect(missing.name).toBe("CommandNotFoundError");
          expect(missing.message).toBe("There is no command /nope");
          const failed = yield* Effect.flip(session.command("fail", "x"));
          expect(failed).toEqual(new CommandFailedError({ command: "fail", cause: failure }));
          expect(failed.message).toBe(`Command /fail failed: ${failure.message}`);
          const died = yield* Effect.exit(session.command("bug", ""));
          expect(Exit.isFailure(died) && Cause.squash(died.cause)).toBe(bug);
          // No Turn started: no Model is provided, and none was asked for.
          expect(yield* session.turns).toEqual([]);
        }),
      );
    }),
  );

  it.effect("interrupts a running Command when the Session closes, before its setup releases", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const started = yield* Deferred.make<void>();
      const turnStarted = yield* Deferred.make<void>();
      const agent = Agent.make({
        use: [
          Extension.make(
            "waiting",
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Effect.sync(() => void log.push("setup released")));
              return {
                commands: [
                  Command.make("wait", {
                    description: "Wait forever",
                    run: () =>
                      Deferred.succeed(started, undefined).pipe(
                        Effect.andThen(Effect.never),
                        Effect.onInterrupt(() =>
                          Effect.sync(() => void log.push("command interrupted")),
                        ),
                      ),
                  }),
                ],
              };
            }),
          ),
        ],
        program: () => Effect.andThen(Deferred.succeed(turnStarted, undefined), Effect.never),
      });
      const scope = yield* Scope.make();
      const session = yield* Session.make(agent).pipe(Scope.provide(scope));
      // A running Turn does not keep a Command from running.
      const turn = yield* Effect.forkChild(session.run("hold"));
      yield* Deferred.await(turnStarted);
      const waiting = yield* Effect.forkChild(session.command("wait", ""));
      yield* Deferred.await(started);
      yield* Scope.close(scope, Exit.void);
      expect(log).toEqual(["command interrupted", "setup released"]);
      expect(Exit.hasInterrupts(yield* Fiber.await(waiting))).toBe(true);
      expect(Exit.hasInterrupts(yield* Fiber.await(turn))).toBe(true);
      // A released Session runs no Command.
      expect(yield* Effect.flip(session.command("wait", ""))).toEqual(new SessionReleasedError());
      expect(log).toEqual(["command interrupted", "setup released"]);
    }),
  );

  it.effect("checks a setup's record while the Host's services are still masked", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      let captured: Fiber.Fiber<unknown, unknown> | undefined;
      const look = (where: string, fiber: Fiber.Fiber<unknown, unknown> | undefined) =>
        seen.push(
          `${where}:${fiber !== undefined && Context.get(fiber.context, Approver) !== undefined ? "somebody" : "nobody"}`,
        );
      const peeking = Extension.make(
        "peeking",
        Effect.sync(() => {
          captured = Fiber.getCurrent();
          return {
            // Read when the record is checked.
            get instructions() {
              look("check", Fiber.getCurrent());
              return "Peek.";
            },
            commands: [
              Command.make("peek", {
                description: "Look through the fiber the setup ran on",
                run: () => Effect.sync(() => (look("captured", captured), Command.reply(""))),
              }),
            ],
          };
        }),
      );
      yield* Effect.scoped(
        Effect.flatMap(Session.make(Agent.make({ use: [peeking] })), (session) =>
          session.command("peek", ""),
        ),
      ).pipe(Effect.provideService(Approver, { decide: () => Effect.succeed("allow") }));
      expect(seen).toEqual(["check:nobody", "captured:nobody"]);
    }),
  );

  it.effect("refuses the step of one Session in a Turn of another, before the Model", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const prompts: Array<Prompt.Prompt> = [];
      let saved: Effect.Effect<unknown, unknown, unknown> | undefined;
      const agent = Agent.make({
        use: [
          logging("notes", "save", log, {
            policy: () => Effect.sync(() => (log.push("policy"), "allow" as const)),
          }),
        ],
        program: (input: string, { step }) =>
          Effect.suspend(() => {
            if (input === "save") {
              saved = step;
              return Effect.succeed("saved");
            }
            // SAFETY: a Step of another Session, typed as this one's.
            return Effect.as(saved as typeof step, "replayed");
          }),
      });
      const model = recording([[call("c1", "save", "a"), finish("tool-calls")]], prompts);
      yield* Effect.scoped(Effect.flatMap(Session.make(agent), (first) => first.run("save"))).pipe(
        Effect.provide(model),
      );
      const exit = yield* Effect.exit(
        Effect.scoped(Effect.flatMap(Session.make(agent), (second) => second.run("replay"))).pipe(
          Effect.provide(model),
        ),
      );
      expect(defect(exit)).toEqual(
        new Error(
          "The step and loop given to an Agent's program run only in Turns of the Session that gave them",
        ),
      );
      expect(prompts).toEqual([]);
      expect(log).toEqual([]);
    }),
  );

  it.effect("releases what a Command acquired when that Command ends", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const agent = Agent.make({
        use: [
          Extension.make("holding", {
            commands: [
              Command.make("hold", {
                description: "Hold something",
                run: () =>
                  Effect.as(
                    Effect.acquireRelease(
                      Effect.sync(() => void log.push("acquired")),
                      () => Effect.sync(() => void log.push("released")),
                    ),
                    Command.reply("held"),
                  ),
              }),
            ],
          }),
        ],
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make(agent);
          expect(yield* session.command("hold", "")).toEqual(Command.reply("held"));
          expect(log).toEqual(["acquired", "released"]);
        }),
      );
    }),
  );

  it.live("closes while a Command's own finalizer waits for its interruption", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const agent = Agent.make({
        use: [
          Extension.make("waiting", {
            commands: [
              Command.make("wait", {
                description: "Wait until interrupted",
                run: () =>
                  Effect.gen(function* () {
                    yield* Effect.addFinalizer(() => Deferred.await(stopped));
                    yield* Deferred.succeed(started, undefined);
                    return yield* Effect.never.pipe(
                      Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
                    );
                  }),
              }),
            ],
          }),
        ],
      });
      const scope = yield* Scope.make();
      const session = yield* Session.make(agent).pipe(Scope.provide(scope));
      const waiting = yield* Effect.forkChild(session.command("wait", ""));
      yield* Deferred.await(started);
      // Awaited apart from the close itself, which cannot be interrupted, so a hang fails the test.
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
      const closed = yield* Fiber.await(closing).pipe(Effect.timeoutOption("2 seconds"));
      expect(Option.isSome(closed)).toBe(true);
      expect(Exit.hasInterrupts(yield* Fiber.await(waiting))).toBe(true);
    }),
  );

  it.effect("runs a finalizer added to the setup's Scope during a Turn after that Turn ends", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const turnStarted = yield* Deferred.make<void>();
      const agent = Agent.make({
        use: [
          Extension.make(
            "late",
            Effect.map(Effect.scope, (setup) => ({
              commands: [
                Command.make("late", {
                  description: "Add a finalizer to the setup",
                  run: () =>
                    Effect.as(
                      Scope.addFinalizer(
                        setup,
                        Effect.sync(() => void log.push("late")),
                      ),
                      Command.reply(""),
                    ),
                }),
              ],
            })),
          ),
        ],
        program: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Effect.sync(() => void log.push("turn")));
            yield* Deferred.succeed(turnStarted, undefined);
            return yield* Effect.never;
          }),
      });
      const scope = yield* Scope.make();
      const session = yield* Session.make(agent).pipe(Scope.provide(scope));
      const turn = yield* Effect.forkChild(session.run("hold"));
      yield* Deferred.await(turnStarted);
      yield* session.command("late", "");
      yield* Scope.close(scope, Exit.void);
      expect(log).toEqual(["turn", "late"]);
      expect(Exit.hasInterrupts(yield* Fiber.await(turn))).toBe(true);
    }),
  );

  it.effect("interrupts a setup still running when its Scope closes, before its release", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const waiting = yield* Deferred.make<void>();
      const agent = Agent.make({
        use: [
          Extension.make(
            "slow",
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.sync(() => void log.push("acquired")),
                () => Effect.sync(() => void log.push("released")),
              );
              return yield* Deferred.succeed(waiting, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Effect.sync(() => void log.push("interrupted"))),
              );
            }),
          ),
        ],
      });
      const scope = yield* Scope.make();
      const making = yield* Effect.forkChild(Session.make(agent).pipe(Scope.provide(scope)));
      yield* Deferred.await(waiting);
      yield* Scope.close(scope, Exit.void);
      expect(log).toEqual(["acquired", "interrupted", "released"]);
      yield* Fiber.interrupt(making);
    }),
  );

  it.effect("gives a policy the Turn of the Step that called it", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const agent = Agent.make({
        use: [
          logging("notes", "save", [], {
            policy: () =>
              Effect.map(Turn, (turn) => (seen.push(`policy:${turn.id}`), "allow" as const)),
          }),
        ],
        program: (input: string, { step }) =>
          Effect.gen(function* () {
            seen.push(`program:${(yield* Turn).id}`);
            yield* user(input);
            yield* step;
            return input;
          }),
      });
      yield* Effect.scoped(
        Effect.flatMap(Session.make(agent), (session) => session.run("go")),
      ).pipe(Effect.provide(recording([[call("c1", "save", "a"), finish("tool-calls")]], [])));
      const [program, policy] = seen;
      expect(seen).toHaveLength(2);
      expect(policy?.replace("policy:", "")).toBe(program?.replace("program:", ""));
    }),
  );

  it.effect("rejects anything but an Agent made by Agent.make, Session options included", () =>
    Effect.gen(function* () {
      const limits = { generations: 1, dispatches: 1 };
      const agent = Agent.make({});
      for (const value of [
        { transcript: "none", limits },
        { transcript: undefined, limits },
        { transcript: "none" },
        { transcript: {}, limits },
        Object.create(agent),
      ]) {
        // SAFETY: deliberately mistyped, so the runtime check sees what the types would reject.
        const exit = yield* Effect.exit(Effect.scoped(Session.make(value as never)));
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(
          new TypeError("Session.make expects an Agent made by Agent.make"),
        );
      }
    }),
  );

  it.effect("gives a custom program the merged step and loop", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const prompts: Array<Prompt.Prompt> = [];
      const agent = Agent.make({
        instructions: "You help.",
        use: [logging("notes", "save", log, { instructions: "Keep notes." })],
        program: (input: { readonly topic: string }, { step, loop }) =>
          Effect.gen(function* () {
            yield* user(input.topic);
            const first = yield* step;
            const last = yield* loop;
            return { first: first._tag, last: last.response.text };
          }),
        text: {
          parse: (topic) => Effect.succeed({ topic }),
          render: (result) => Effect.succeed(result.last),
        },
      });
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make(agent);
          return yield* session.run({ topic: "go" }).pipe(
            Effect.provide(
              recording(
                [
                  [call("c1", "save", "a"), finish("tool-calls")],
                  [text("done"), finish("stop")],
                ],
                prompts,
              ),
            ),
          );
        }),
      );
      expect(result).toEqual({ first: "Complete", last: "done" });
      expect(log).toEqual(["save:a"]);
      expect(prompts.map(system)).toEqual(["You help.\n\nKeep notes.", "You help.\n\nKeep notes."]);
    }),
  );

  it.effect("runs an Agent overridden through Agent.make and rejects a bare spread", () =>
    Effect.gen(function* () {
      const prompts: Array<Prompt.Prompt> = [];
      const base = Agent.make({
        instructions: "Base.",
        use: [Extension.make("notes", { instructions: "Keep notes." })],
      });
      const overridden = Agent.make({ ...base, instructions: "Override." });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* Session.make(overridden);
          yield* session
            .run("go")
            .pipe(Effect.provide(recording([[text("done"), finish("stop")]], prompts)));
        }),
      );
      expect(system(prompts[0])).toBe("Override.\n\nKeep notes.");

      // SAFETY: deliberately mistyped; a spread copy has the fields but not the brand.
      const copy = { ...base } as typeof base;
      const exit = yield* Effect.exit(Effect.scoped(Session.make(copy)));
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(
        new TypeError("Session.make expects an Agent made by Agent.make"),
      );
    }),
  );

  it.effect(
    "the same Agent runs from a test with `Session.make(agent)` and a scripted Model, with no Configuration and no Host",
    () =>
      Effect.gen(function* () {
        const deleted: Array<string> = [];
        const Delete = Tool.make("delete_note", {
          parameters: Schema.Struct({ key: Schema.String }),
          success: Schema.String,
          needsApproval: true,
        });
        const NotesKit = Toolkit.make(Delete);
        const notes = Extension.make(
          "notes",
          Effect.sync(() => ({
            tools: NotesKit,
            handlers: NotesKit.of({
              delete_note: ({ key }) => Effect.sync(() => (deleted.push(key), `deleted ${key}`)),
            }),
          })),
        );
        const agent = Agent.make({ instructions: "You keep notes.", use: [notes] });
        const turn = (approver: Layer.Layer<never>) =>
          Effect.scoped(
            Effect.gen(function* () {
              const prompts: Array<Prompt.Prompt> = [];
              const session = yield* Session.make(agent);
              const result = yield* session.run("delete a").pipe(
                Effect.provide(
                  Layer.merge(
                    recording(
                      [
                        [call("c1", "delete_note", "a"), finish("tool-calls")],
                        [text("finished"), finish("stop")],
                      ],
                      prompts,
                    ),
                    approver,
                  ),
                ),
              );
              return { result, first: prompts[0], told: JSON.stringify(prompts[1]) };
            }),
          );

        // Nobody is present: the Tool is denied, the Model is told and the Turn completes.
        const alone = yield* turn(Layer.empty);
        expect(alone.result).toBe("finished");
        // The default program staged exactly the input as the user Message.
        const staged = alone.first?.content.filter((message) => message.role === "user");
        expect(staged?.map((message) => message.content)).toEqual([
          [expect.objectContaining({ type: "text", text: "delete a" })],
        ]);
        expect(deleted).toEqual([]);
        expect(alone.told).toContain("Tool call needs approval and nobody is present to give it");

        // With an Approver the handler runs.
        const approved = yield* turn(
          Layer.succeed(Approver, { decide: () => Effect.succeed("allow") }),
        );
        expect(approved.result).toBe("finished");
        expect(deleted).toEqual(["a"]);
        expect(approved.told).toContain("deleted a");
      }),
  );
});
