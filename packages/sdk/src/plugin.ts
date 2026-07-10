import { Effect, Schema } from "effect";
import { AiError, Tool as AiTool, Toolkit } from "effect/unstable/ai";
import { DefinitionError } from "@mitome/core";
import type { Plugin } from "@mitome/core";
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";

type EffectSchema<Output> = Schema.Codec<Output, unknown, never, never>;

export type StandardSchema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output>;
export type InputSchema<Input = unknown> =
  | (StandardSchemaV1<unknown, Input> & StandardJSONSchemaV1<unknown, Input>)
  | EffectSchema<Input>;
export type OutputSchema<Output = unknown> =
  | StandardSchemaV1<unknown, Output>
  | EffectSchema<Output>;

// The ESNext-only library config omits the DOM AbortSignal declaration.
export interface ToolHandlerContext {
  readonly signal: {
    readonly aborted: boolean;
    readonly addEventListener: (
      type: "abort",
      listener: () => void,
      options?: { readonly once?: boolean },
    ) => void;
  };
}

export interface Tool<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: InputSchema<Input>;
  readonly outputSchema: OutputSchema<Output>;
  readonly handler: (input: Input, context: ToolHandlerContext) => Promise<Output>;
}

export const tool = <Input, Output>(definition: Tool<Input, Output>): Tool<Input, Output> =>
  definition;

type StandardInput<Input> = StandardSchemaV1.Props<unknown, Input> &
  StandardJSONSchemaV1.Props<unknown, Input>;

const standardInput = <Input>(schema: InputSchema<Input>): StandardInput<Input> => {
  if (Schema.isSchema(schema)) {
    return Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))["~standard"];
  }
  const standard = schema["~standard"];
  if (!("validate" in standard) || !("jsonSchema" in standard)) {
    throw new DefinitionError({
      message: "Tool input schema must provide validation and JSON Schema",
    });
  }
  return standard;
};

const standardOutput = <Output>(
  schema: OutputSchema<Output>,
): StandardSchemaV1.Props<unknown, Output> => {
  if (Schema.isSchema(schema)) {
    return Schema.toStandardSchemaV1(schema)["~standard"];
  }
  const standard = schema["~standard"];
  if (!("validate" in standard)) {
    throw new DefinitionError({ message: "Tool output schema must provide validation" });
  }
  return standard;
};

const validate = async <Output>(
  standard: StandardSchemaV1.Props<unknown, Output>,
  value: unknown,
): Promise<Output> => {
  const result = await standard.validate(value);
  if (result.issues) throw new Error(result.issues[0]?.message ?? "Schema validation failed");
  return result.value;
};

export const definePlugin = (definition: {
  readonly name: string;
  readonly tools: ReadonlyArray<Tool<any, any>>;
}): Plugin => {
  const names = new Set<string>();
  const definitions = definition.tools.map((tool) => {
    if (names.has(tool.name)) {
      throw new DefinitionError({ message: `Duplicate Tool name: ${tool.name}` });
    }
    names.add(tool.name);
    return {
      tool,
      input: standardInput(tool.inputSchema),
      output: standardOutput(tool.outputSchema),
    };
  });

  return {
    name: definition.name,
    toolkit: Toolkit.make(
      ...definitions.map(({ tool, input }) =>
        AiTool.dynamic(tool.name, {
          description: tool.description,
          parameters: input.jsonSchema.input({ target: "draft-2020-12" }),
          failureMode: "return",
        }),
      ),
    ),
    handlers: Object.fromEntries(
      definitions.map(({ tool, input, output }) => [
        tool.name,
        (params: unknown) =>
          Effect.tryPromise({
            try: async (signal) =>
              validate(output, await tool.handler(await validate(input, params), { signal })),
            // SDK handlers are untrusted promises; the model gets a stable failure instead.
            catch: () =>
              AiError.make({
                module: "@mitome/sdk",
                method: tool.name,
                reason: new AiError.UnknownError({ description: "SDK tool handler failed" }),
              }),
          }),
      ]),
    ),
  };
};
