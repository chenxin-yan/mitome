import { Cause, Effect, Exit, Stream } from "effect";
import { AiError, Tool as AiTool, Toolkit } from "effect/unstable/ai";
import { createSession, DefinitionError, validateDefinition } from "@mitome/core";
import type { Definition, Plugin, TurnEvent } from "@mitome/core";

export type { Definition, Model, Plugin, TurnEvent } from "@mitome/core";

type ValidationResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string }> };

type StandardProperties<Input, Output> = {
  readonly version: 1;
  readonly vendor: string;
  readonly types?: { readonly input: Input; readonly output: Output };
};

export type StandardSchema<Input = unknown, Output = Input> =
  | {
      readonly "~standard": StandardProperties<Input, Output> & {
        readonly validate: (
          value: unknown,
        ) => ValidationResult<Output> | Promise<ValidationResult<Output>>;
      };
    }
  | {
      readonly "~standard": StandardProperties<Input, Output> & {
        readonly jsonSchema: {
          readonly input: (options: { readonly target: string }) => Record<string, unknown>;
          readonly output: (options: { readonly target: string }) => Record<string, unknown>;
        };
      };
    };

export interface Tool<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: StandardSchema<unknown, Input>;
  readonly outputSchema: StandardSchema<unknown, Output>;
  readonly handler: (input: Input) => Promise<Output>;
}

export interface Session {
  readonly prompt: (text: string) => AsyncIterable<TurnEvent>;
}

export const tool = <Input, Output>(definition: Tool<Input, Output>): Tool<Input, Output> =>
  definition;

const jsonSchema = (schema: StandardSchema): Record<string, unknown> => {
  const standard = schema["~standard"];
  return "jsonSchema" in standard ? standard.jsonSchema.input({ target: "draft-2020-12" }) : {};
};

const validate = async <Output>(
  schema: StandardSchema<unknown, Output>,
  value: unknown,
): Promise<Output> => {
  const standard = schema["~standard"];
  // JSON-Schema-only tools have no runtime validation protocol; their schema is sent to the model.
  if (!("validate" in standard)) return value as Output;
  const result = await standard.validate(value);
  if (result.issues) {
    throw new Error(result.issues[0]?.message ?? "Schema validation failed");
  }
  return result.value;
};

export const definePlugin = (definition: {
  readonly name: string;
  readonly tools: ReadonlyArray<Tool>;
}): Plugin => {
  const names = new Set<string>();
  for (const tool of definition.tools) {
    if (names.has(tool.name)) throw new DefinitionError(`Duplicate Tool name: ${tool.name}`);
    names.add(tool.name);
  }

  const tools = definition.tools.map((definition) =>
    AiTool.dynamic(definition.name, {
      description: definition.description,
      parameters: jsonSchema(definition.inputSchema),
      failureMode: "return",
    }),
  );

  return {
    name: definition.name,
    toolkit: Toolkit.make(...tools),
    handlers: Object.fromEntries(
      definition.tools.map((definition) => [
        definition.name,
        (params: unknown) =>
          Effect.tryPromise({
            try: async () => {
              const input = await validate(definition.inputSchema, params);
              return await validate(definition.outputSchema, await definition.handler(input));
            },
            // SDK handlers are untrusted promises; the model gets a stable failure instead.
            catch: () =>
              AiError.make({
                module: "@mitome/sdk",
                method: definition.name,
                reason: new AiError.UnknownError({ description: "SDK tool handler failed" }),
              }),
          }),
      ]),
    ),
  };
};

export const defineAgent = (definition: Definition): Definition => {
  validateDefinition(definition);
  return definition;
};

class CallbackFailure {
  constructor(readonly cause: unknown) {}
}

export const withSession = <A>(
  definition: Definition,
  use: (session: Session) => Promise<A>,
): Promise<A> =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* createSession(definition);
        return yield* Effect.tryPromise({
          try: () =>
            use({
              prompt: (text) => Stream.toAsyncIterable(session.prompt(text)),
            }),
          catch: (error) => new CallbackFailure(error),
        });
      }),
    ),
  ).then((exit) => {
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }

    const failure = Cause.squash(exit.cause);
    if (failure instanceof CallbackFailure) {
      throw failure.cause;
    }
    throw failure;
  });
