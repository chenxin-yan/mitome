import { Context, Effect, Schema } from "effect";
import { AiError, Prompt, Tool } from "effect/unstable/ai";
import type { AnyPlugin, ToolResultValidator } from "./definition.js";
import type { ToolExecutionDenied } from "./events.js";

export const coreModuleName = "@mitome/core";

export type PluginContexts = ReadonlyMap<AnyPlugin, Context.Context<any>>;

export const providePlugin = <A, E>(
  plugin: AnyPlugin | undefined,
  contexts: PluginContexts,
  effect: Effect.Effect<A, E, any>,
): Effect.Effect<A, E> => {
  const context = plugin === undefined ? undefined : contexts.get(plugin);
  return (context === undefined ? effect : Effect.provide(effect, context)) as Effect.Effect<A, E>;
};

export const transformPrompt = (
  plugins: ReadonlyArray<AnyPlugin>,
  contexts: PluginContexts,
  prompt: Prompt.Prompt,
): Effect.Effect<Prompt.Prompt, unknown> =>
  Effect.gen(function* () {
    let current = prompt;
    for (const plugin of plugins) {
      current = yield* providePlugin(
        plugin,
        contexts,
        plugin.hooks?.preStep?.(current) ?? Effect.succeed(current),
      );
    }
    return current;
  });

export const failureResult = (reason: string): Tool.HandlerResult<Tool.Any> => {
  const result: ToolExecutionDenied = { type: "execution-denied", reason };
  return {
    result,
    encodedResult: result,
    isFailure: true,
    preliminary: false,
  } as Tool.HandlerResult<Tool.Any>;
};

export const validateResult = (
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

const describeFailure = (message: string, cause: unknown): string =>
  `${message}: ${cause instanceof Error ? cause.message : String(cause)}`;

export const hookAiError = (method: string, message: string) =>
  Effect.mapError((cause: unknown) => {
    const reason = AiError.isAiError(cause)
      ? cause.reason
      : AiError.isAiErrorReason(cause)
        ? cause
        : new AiError.UnknownError({ description: describeFailure(message, cause) });
    return AiError.make({ module: coreModuleName, method, reason });
  });

export const toolAiError = (method: string) =>
  Effect.mapError((cause: unknown) =>
    AiError.isAiError(cause)
      ? cause
      : AiError.make({
          module: coreModuleName,
          method,
          reason: AiError.isAiErrorReason(cause)
            ? cause
            : new AiError.UnknownError({
                description: describeFailure("Tool execution failed", cause),
              }),
        }),
  );

export type PreparedTool =
  | {
      readonly _tag: "ok";
      readonly key: string;
      readonly toolCallId: string;
      readonly params: unknown;
      readonly veto: string | undefined;
    }
  | {
      readonly _tag: "failure";
      readonly key: string;
      readonly toolCallId: string;
      readonly params: unknown;
      readonly hookFailure: unknown;
    };
