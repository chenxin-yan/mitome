import { Effect, Schema, Stream } from "effect";
import { Tool, Toolkit, type AiError } from "effect/unstable/ai";
import type { CompiledAgent } from "../agent.js";
import type { PluginContexts, ToolResultValidator } from "../plugin.js";
import { providePlugin } from "../plugin.js";
import { hookAiError, toolAiError } from "./errors.js";

const validateResult = (
  tool: Tool.Any,
  handlerResult: Tool.HandlerResult<Tool.Any>,
  result: unknown,
  validator: ToolResultValidator | undefined,
): Effect.Effect<Tool.HandlerResult<Tool.Any>, unknown> =>
  Effect.gen(function* () {
    // Result validators describe successful SDK outputs; failures use their Tool failure schema instead.
    const validated =
      handlerResult.isFailure || validator === undefined ? result : yield* validator(result);
    // Dynamic Tools have no failure schema to re-encode with, so the Hook-transformed
    // value doubles as the encoded payload the model sees.
    if (handlerResult.isFailure && Tool.isDynamic(tool) && tool.failureSchema === Schema.Never) {
      return {
        ...handlerResult,
        result: validated,
        encodedResult: validated,
      } as Tool.HandlerResult<Tool.Any>;
    }
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
  readonly execute: (
    name: string,
    params: unknown,
  ) => Effect.Effect<Stream.Stream<Tool.HandlerResult<Tool.Any>>, AiError.AiError>;
};

export const makeToolkit = (
  compiled: CompiledAgent,
  contexts: PluginContexts,
): Effect.Effect<ComposedToolkit, never> => {
  const toolkit = Toolkit.make(...Object.values(compiled.tools));
  // Cross-Plugin handlers are heterogeneous, so their merged record cannot satisfy Toolkit.HandlersFrom.
  return toolkit.toHandlers(compiled.handlers as never).pipe(
    Effect.flatMap((handlers) => Effect.provide(toolkit, handlers)),
    Effect.map((handlers): ComposedToolkit => {
      const handle = handlers.handle as Toolkit.WithHandler<Record<string, Tool.Any>>["handle"];
      const execute = (
        name: string,
        params: unknown,
      ): Effect.Effect<Stream.Stream<Tool.HandlerResult<Tool.Any>>, AiError.AiError> =>
        Effect.gen(function* () {
          // The whole Tool call runs in the owning Plugin's context: the handler
          // itself plus any schema decode/encode services from its resource.
          const owner = compiled.toolOwners.get(name);
          const tool = handlers.tools[name] as Tool.Any;
          const results = yield* providePlugin(
            owner,
            contexts,
            handle(name, params).pipe(
              Effect.flatMap((stream) =>
                Stream.runCollect(
                  // Collection keeps the handler stream and its Hooks inside
                  // streamText's per-call concurrency slot (ADR-0005).
                  stream as unknown as Stream.Stream<Tool.HandlerResult<Tool.Any>, unknown>,
                ),
              ),
            ),
          ).pipe(toolAiError(name));
          if (!compiled.plugins.some((plugin) => plugin.hooks?.postTool !== undefined)) {
            return Stream.fromIterable(results);
          }
          const validator = compiled.toolResultValidators[name];
          const finalResults = yield* Effect.forEach(results, (handlerResult) =>
            Effect.gen(function* () {
              let result = handlerResult.result;
              for (const plugin of compiled.plugins) {
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
      return { tools: handlers.tools as Record<string, Tool.Any>, execute };
    }),
  );
};
