import { Effect, Schema, Stream } from "effect";
import { Tool, Toolkit, type AiError } from "effect/unstable/ai";
import type { AnyPlugin, PluginContexts, ToolResultValidator } from "../plugin.js";
import { providePlugin } from "../plugin.js";
import { hookAiError, toolAiError } from "./errors.js";

const validateResult = (
  tool: Tool.Any,
  handlerResult: Tool.HandlerResult<Tool.Any>,
  result: unknown,
  validator: ToolResultValidator | undefined,
): Effect.Effect<Tool.HandlerResult<Tool.Any>, unknown> =>
  Effect.gen(function* () {
    const validated = validator === undefined ? result : yield* validator(result);
    const schema = handlerResult.isFailure ? tool.failureSchema : tool.successSchema;
    const encodedResult = yield* Schema.encodeUnknownEffect(schema)(validated);
    return {
      result: validated,
      encodedResult,
      isFailure: handlerResult.isFailure,
      preliminary: handlerResult.preliminary,
    } as Tool.HandlerResult<Tool.Any>;
  }) as Effect.Effect<Tool.HandlerResult<Tool.Any>, unknown>;

/** The composed Plugin Toolkit: contributed Tools, their handlers, and the post-Tool pipeline. */
export type ComposedToolkit = {
  readonly tools: Record<string, Tool.Any>;
  readonly decodeParameters: (name: string, params: unknown) => Effect.Effect<unknown, unknown>;
  readonly execute: (
    name: string,
    params: unknown,
  ) => Effect.Effect<Stream.Stream<Tool.HandlerResult<Tool.Any>>, AiError.AiError>;
};

export const makeToolkit = (
  plugins: ReadonlyArray<AnyPlugin>,
  contexts: PluginContexts,
): Effect.Effect<ComposedToolkit, never> => {
  const baseTools = plugins.flatMap((plugin) => Object.values(plugin.toolkit?.tools ?? {}));
  const owners = new Map<string, AnyPlugin>();
  for (const plugin of plugins) {
    for (const tool of Object.values(plugin.toolkit?.tools ?? {})) owners.set(tool.name, plugin);
  }
  const validators: Readonly<Record<string, ToolResultValidator>> = Object.assign(
    {},
    ...plugins.map((plugin) => plugin.toolResultValidators ?? {}),
  );
  const toolkit = Toolkit.make(...baseTools);
  return toolkit
    .toHandlers(Object.assign({}, ...plugins.map((plugin) => plugin.handlers ?? {})) as never)
    .pipe(
      Effect.flatMap((handlers) => Effect.provide(toolkit, handlers)),
      Effect.map((handlers): ComposedToolkit => {
        const handle = handlers.handle as Toolkit.WithHandler<Record<string, Tool.Any>>["handle"];
        const decodeParameters = (
          name: string,
          params: unknown,
        ): Effect.Effect<unknown, unknown> => {
          const tool = handlers.tools[name] as Tool.Any;
          return providePlugin(
            owners.get(name),
            contexts,
            Schema.decodeUnknownEffect(tool.parametersSchema)(params),
          );
        };
        const execute = (
          name: string,
          params: unknown,
        ): Effect.Effect<Stream.Stream<Tool.HandlerResult<Tool.Any>>, AiError.AiError> =>
          Effect.gen(function* () {
            // The whole Tool call runs in the owning Plugin's context: the handler
            // itself plus any schema decode/encode services from its resource.
            const owner = owners.get(name);
            const tool = handlers.tools[name] as Tool.Any;
            const results = yield* providePlugin(
              owner,
              contexts,
              handle(name, params).pipe(
                Effect.flatMap((stream) =>
                  Stream.runCollect(
                    stream as unknown as Stream.Stream<Tool.HandlerResult<Tool.Any>, unknown>,
                  ),
                ),
              ),
            ).pipe(toolAiError(name));
            if (!plugins.some((plugin) => plugin.hooks?.postTool !== undefined)) {
              return Stream.fromIterable(results);
            }
            const validator = validators[name];
            const finalResults = yield* Effect.forEach(results, (handlerResult) =>
              Effect.gen(function* () {
                // Schema-less dynamic Tool failures are already encoded and have no failure schema.
                if (
                  handlerResult.isFailure &&
                  (validator !== undefined ||
                    (Tool.isDynamic(tool) && tool.failureSchema === Schema.Never))
                ) {
                  return handlerResult;
                }

                let result = handlerResult.result;
                for (const plugin of plugins) {
                  const postTool = plugin.hooks?.postTool;
                  if (postTool !== undefined) {
                    result = yield* providePlugin(
                      plugin,
                      contexts,
                      postTool({
                        name,
                        params,
                        result,
                        isFailure: handlerResult.isFailure,
                      }),
                    ).pipe(hookAiError("postTool", "Post-Tool Hook failed"));
                  }
                }
                return yield* providePlugin(
                  owner,
                  contexts,
                  validateResult(tool, handlerResult, result, validator),
                ).pipe(hookAiError("postTool", "Post-Tool result validation failed"));
              }),
            );
            return Stream.fromIterable(finalResults);
          });
        return { tools: handlers.tools as Record<string, Tool.Any>, decodeParameters, execute };
      }),
    );
};
