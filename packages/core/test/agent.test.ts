import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { compileAgentDefinition } from "../src/agent.js";
import type { ToolInput, ToolOutput } from "../src/extension.js";
import {
  AgentDefinitionError,
  defineAgent,
  makeProvider,
  type AgentDefinition,
} from "../src/index.js";
import { makeTestProvider } from "./support/provider.js";

const model = makeTestProvider(() => Stream.empty);
const getAgentDefinitionError = (definition: typeof Schema.Unknown.Type) =>
  Effect.flip(compileAgentDefinition(definition));

type AgentDefinitionKeysAreExact = keyof AgentDefinition extends
  | "providers"
  | "model"
  | "extensions"
  ? "providers" | "model" | "extensions" extends keyof AgentDefinition
    ? true
    : false
  : false;
const exactAgentDefinitionKeys: AgentDefinitionKeysAreExact = true;
void exactAgentDefinitionKeys;

// @ts-expect-error Agent Definition Instructions are contributed by Extensions.
defineAgent({ instructions: "old", providers: [model], model: "test/default", extensions: [] });

describe("Agent Definition compilation", () => {
  it.effect("compiles the runtime data consumed by a Session", () =>
    Effect.gen(function* () {
      const echo = Tool.make("echo", { success: Schema.String });
      const count = Tool.make("count", { success: Schema.Finite });
      const echoHandler = () => Effect.succeed("echo");
      const countHandler = () => Effect.succeed(1);
      const echoInput = (input: ToolInput) => Effect.succeed(input);
      const countResult = (result: ToolOutput) => Effect.succeed(result);
      const first = {
        name: "first",
        instructions: "First",
        toolkit: Toolkit.make(echo),
        toolInputValidators: { echo: echoInput },
      };
      const second = {
        name: "second",
        instructions: "Second",
        toolkit: Toolkit.make(count),
        handlers: { echo: echoHandler, count: countHandler },
        toolResultValidators: { count: countResult },
      };

      const compiled = yield* compileAgentDefinition({
        providers: [model],
        model: "test/default",
        extensions: [first, second],
      });

      expect(compiled.extensions).toEqual([first, second]);
      expect([...compiled.providers]).toEqual([["test", model]]);
      expect([...compiled.tools]).toEqual([
        [
          "echo",
          {
            tool: echo,
            owner: first,
            handler: echoHandler,
            inputValidator: echoInput,
            resultValidator: undefined,
          },
        ],
        [
          "count",
          {
            tool: count,
            owner: second,
            handler: countHandler,
            inputValidator: undefined,
            resultValidator: countResult,
          },
        ],
      ]);
      expect(compiled.instructions).toBe("First\n\nSecond");
    }),
  );

  it.effect("resolves Extension dependencies once in stable dependency-first order", () =>
    Effect.gen(function* () {
      const shared = { name: "shared", instructions: "Shared" };
      const first = { name: "first", instructions: "First", dependencies: [shared] };
      const second = { name: "second", instructions: "Second", dependencies: [shared] };
      const root = { name: "root", instructions: "Root", dependencies: [first, second] };

      const compiled = yield* compileAgentDefinition({
        providers: [model],
        model: "test/default",
        extensions: [root, shared],
      });

      expect(compiled.extensions).toEqual([shared, first, second, root]);
      expect(compiled.instructions).toBe("Shared\n\nFirst\n\nSecond\n\nRoot");
    }),
  );

  it.effect("reports Extension dependency conflicts and cycles with deterministic paths", () =>
    Effect.gen(function* () {
      const conflictA = { name: "conflict" };
      const conflictB = { name: "conflict" };
      const conflictC = { name: "conflict" };
      interface DependencyNode {
        readonly name: string;
        dependencies?: Array<DependencyNode>;
      }
      const alpha: DependencyNode = { name: "alpha" };
      const beta: DependencyNode = { name: "beta" };
      alpha.dependencies = [beta];
      beta.dependencies = [alpha];
      const self: DependencyNode = { name: "self" };
      self.dependencies = [self];
      const a: DependencyNode = { name: "a" };
      const b: DependencyNode = { name: "b" };
      a.dependencies = [b];
      b.dependencies = [a];

      const error = yield* getAgentDefinitionError({
        providers: [model],
        model: "test/default",
        extensions: [
          conflictA,
          { name: "owner", dependencies: [conflictB, conflictC] },
          alpha,
          self,
          { name: "root", dependencies: [a] },
        ],
      });

      expect(error.issues).toEqual([
        "Conflicting Extension name: conflict refers to different values",
        "Extension dependency cycle: alpha -> beta -> alpha",
        "Extension dependency cycle: self -> self",
        "Extension dependency cycle: a -> b -> a",
      ]);
    }),
  );

  it.effect("compiles an auto-included dependency's Tool contributions", () =>
    Effect.gen(function* () {
      const tool = Tool.make("dep-tool", { success: Schema.String });
      const handler = () => Effect.succeed("ok");
      const dependency = {
        name: "dependency",
        toolkit: Toolkit.make(tool),
        handlers: { "dep-tool": handler },
      };

      const compiled = yield* compileAgentDefinition({
        providers: [model],
        model: "test/default",
        extensions: [{ name: "root", dependencies: [dependency] }],
      });

      expect(compiled.tools.get("dep-tool")).toEqual({
        tool,
        owner: dependency,
        handler,
        inputValidator: undefined,
        resultValidator: undefined,
      });
    }),
  );

  it.effect("aggregates malformed dependency declarations", () =>
    Effect.gen(function* () {
      const error = yield* getAgentDefinitionError({
        providers: [model],
        model: "test/default",
        extensions: [
          { name: "not-an-array", dependencies: null },
          { name: "bad-elements", dependencies: [null, { name: 1 }, { name: "valid" }] },
        ],
      });

      expect(error.issues).toEqual([
        "Extension not-an-array Dependencies must be an array",
        "Extension dependency bad-elements[0] must be an object with a string name",
        "Extension dependency bad-elements[1] must be an object with a string name",
      ]);
    }),
  );

  it.effect("aggregates malformed provided Service declarations", () =>
    Effect.gen(function* () {
      const error = yield* getAgentDefinitionError({
        providers: [model],
        model: "test/default",
        extensions: [
          { name: "not-an-array", provides: null },
          { name: "bad-elements", provides: [null, { key: "not-a-context-key" }] },
        ],
      });

      expect(error.issues).toEqual([
        "Extension not-an-array Provides must be an array",
        "Extension bad-elements Provides[0] must be a Context Key",
        "Extension bad-elements Provides[1] must be a Context Key",
      ]);
    }),
  );

  it.effect("preserves special Tool names in the compiled registry", () =>
    Effect.gen(function* () {
      const tool = Tool.make("__proto__", { success: Schema.String });
      const handler = () => Effect.succeed("ok");
      const compiled = yield* compileAgentDefinition({
        providers: [model],
        model: "test/default",
        extensions: [
          {
            name: "special",
            toolkit: Toolkit.make(tool),
            handlers: Object.fromEntries([[tool.name, handler]]),
          },
        ],
      });

      expect(compiled.tools.get(tool.name)).toEqual({
        tool,
        owner: compiled.extensions[0],
        handler,
        inputValidator: undefined,
        resultValidator: undefined,
      });
    }),
  );

  it.effect("aggregates violations in deterministic order", () =>
    Effect.gen(function* () {
      const provider = makeProvider("registered", [] as const, undefined, () => {
        throw new Error("compilation must not provision Models");
      });
      const echo = Tool.make("echo", { success: Schema.String });
      const missing = Tool.make("missing", { success: Schema.String });
      const structural = {
        providers: [null, provider, provider],
        model: "unregistered/model",
        extensions: [
          {
            name: "same",
            toolkit: Toolkit.make(echo, missing),
            handlers: { echo: () => Effect.succeed("echo") },
            toolInputValidators: { otherInput: Effect.succeed },
            toolResultValidators: { otherResult: Effect.succeed },
          },
          {
            name: "same",
            instructions: 1,
            toolkit: Toolkit.make(echo),
            handlers: {
              echo: () => Effect.succeed("duplicate"),
              orphan: () => Effect.succeed("orphan"),
            },
          },
        ],
      };

      const error = yield* getAgentDefinitionError(structural);
      expect(error).toBeInstanceOf(AgentDefinitionError);
      expect(error.issues).toEqual([
        "Provider at index 0 must be an object with a string id",
        "Duplicate Provider id: registered",
        "Unregistered Provider id: unregistered",
        "Conflicting Extension name: same refers to different values",
        "Tool input validator has no matching Tool: otherInput",
        "Tool result validator has no matching Tool: otherResult",
        "Extension same Instructions must be a string",
        "Duplicate Tool name: echo",
        "Duplicate Tool handler name: echo",
        "Missing Tool handler: missing",
        "Tool handler has no matching Tool: orphan",
      ]);
      expect(error.message).toBe(error.issues.join("\n"));
    }),
  );

  it.effect("reports malformed top-level structure", () =>
    Effect.gen(function* () {
      for (const value of [null, []]) {
        expect((yield* getAgentDefinitionError(value)).issues).toEqual([
          "Agent Definition must be an object",
        ]);
      }
      expect((yield* getAgentDefinitionError({})).issues).toEqual([
        "Agent Definition Providers must be an array",
        "Agent Definition Model must be a string",
        "Agent Definition Extensions must be an array",
      ]);
    }),
  );

  it.effect("does not normalize a null Extensions value", () =>
    Effect.gen(function* () {
      // SAFETY: Deliberately bypass the TypeScript boundary to exercise malformed JavaScript input.
      const definition = (defineAgent as (definition: any) => AgentDefinition)({
        providers: [model],
        model: "test/default",
        extensions: null,
      });

      expect((yield* getAgentDefinitionError(definition)).issues).toEqual([
        "Agent Definition Extensions must be an array",
      ]);
    }),
  );

  it.effect("reports malformed Provider elements", () =>
    Effect.gen(function* () {
      const definition = {
        providers: [null],
        model: "test/default",
        extensions: [],
      };

      expect((yield* getAgentDefinitionError(definition)).issues).toEqual([
        "Provider at index 0 must be an object with a string id",
        "Unregistered Provider id: test",
      ]);
    }),
  );

  it.effect("reports malformed Extension elements and Instructions", () =>
    Effect.gen(function* () {
      const definition = {
        providers: [model],
        model: "test/default",
        extensions: [null, { name: 1, instructions: false }, { name: "named", instructions: 1 }],
      };

      expect((yield* getAgentDefinitionError(definition)).issues).toEqual([
        "Extension at index 0 must be an object with a string name",
        "Extension at index 1 must be an object with a string name",
        "Extension named Instructions must be a string",
      ]);
    }),
  );

  it.effect("reports malformed and unregistered Default Models", () =>
    Effect.gen(function* () {
      const invalidDefinition = (selected: typeof Schema.Unknown.Type) => ({
        providers: [model],
        model: selected,
        extensions: [],
      });

      expect((yield* getAgentDefinitionError(invalidDefinition(1))).issues).toEqual([
        "Agent Definition Model must be a string",
      ]);
      expect((yield* getAgentDefinitionError(invalidDefinition("test/"))).issues).toEqual([
        "Malformed Qualified Model id: test/",
      ]);
      expect((yield* getAgentDefinitionError(invalidDefinition("missing/model"))).issues).toEqual([
        "Unregistered Provider id: missing",
      ]);
    }),
  );

  it.effect("reports missing and orphaned Tool handlers", () =>
    Effect.gen(function* () {
      const missing: AgentDefinition = {
        providers: [model],
        model: "test/default",
        extensions: [
          {
            name: "missing",
            toolkit: Toolkit.make(Tool.make("echo", { success: Schema.String })),
          },
        ],
      };
      const orphaned: AgentDefinition = {
        providers: [model],
        model: "test/default",
        extensions: [{ name: "orphaned", handlers: { echo: () => Effect.succeed("echo") } }],
      };

      expect((yield* getAgentDefinitionError(missing)).issues).toEqual([
        "Missing Tool handler: echo",
      ]);
      expect((yield* getAgentDefinitionError(orphaned)).issues).toEqual([
        "Tool handler has no matching Tool: echo",
      ]);
    }),
  );
});
