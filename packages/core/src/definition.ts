import { Effect, Schema } from "effect";
import { Prompt, Tool, Toolkit } from "effect/unstable/ai";
import type { Model } from "./model.js";

export interface ToolHookContext {
  readonly name: string;
  readonly params: unknown;
}

export interface ToolResultHookContext extends ToolHookContext {
  readonly result: unknown;
  readonly isFailure: boolean;
}

export interface PluginHooks {
  readonly sessionStart?: Effect.Effect<void, unknown>;
  readonly sessionEnd?: Effect.Effect<void, unknown>;
  readonly turnStart?: (text: string) => Effect.Effect<void, unknown>;
  readonly turnEnd?: (text: string) => Effect.Effect<void, unknown>;
  readonly stepStart?: (prompt: Prompt.Prompt) => Effect.Effect<void, unknown>;
  readonly stepEnd?: (prompt: Prompt.Prompt) => Effect.Effect<void, unknown>;
  readonly preStep?: (prompt: Prompt.Prompt) => Effect.Effect<Prompt.Prompt, unknown>;
  readonly preTool?: (
    context: ToolHookContext,
  ) => Effect.Effect<void | { readonly reason: string }, unknown>;
  readonly postTool?: (context: ToolResultHookContext) => Effect.Effect<unknown, unknown>;
}

export interface Plugin {
  readonly name: string;
  readonly toolkit?: Toolkit.Any;
  readonly handlers?: Record<string, (params: unknown) => Effect.Effect<unknown, unknown>>;
  readonly hooks?: PluginHooks;
}

export interface Definition {
  readonly instructions: string;
  readonly model: Model;
  readonly plugins: ReadonlyArray<Plugin>;
}

export class DefinitionError extends Schema.TaggedErrorClass<DefinitionError>()("DefinitionError", {
  message: Schema.String,
}) {}

export const defineAgent = <const Value extends Definition>(definition: Value): Value => definition;

type ServiceFreeToolkit<Tools extends Record<string, Tool.Any>> = [
  Tool.HandlerServices<Tools[keyof Tools]>,
] extends [never]
  ? Toolkit.Toolkit<Tools>
  : never;

export function definePlugin<const Tools extends Record<string, Tool.Any>>(plugin: {
  readonly name: string;
  readonly toolkit: ServiceFreeToolkit<Tools>;
  readonly handlers: Toolkit.HandlersFrom<Tools>;
  readonly hooks?: PluginHooks;
}): Plugin;
export function definePlugin(plugin: Plugin): Plugin;
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

const toolRequiresHandler = (tool: Tool.Any): boolean =>
  Tool.isProviderDefined(tool) ? tool.requiresHandler : true;

export const validateDefinition: (definition: Definition) => Effect.Effect<void, DefinitionError> =
  Effect.fn("@mitome/core/validateDefinition")(function* (definition) {
    const pluginNames = new Set<string>();
    const toolNames = new Set<string>();
    const handlerNames = new Set<string>();
    const requiredHandlerNames = new Set<string>();

    for (const plugin of definition.plugins) {
      if (pluginNames.has(plugin.name)) {
        return yield* new DefinitionError({
          message: `Duplicate Plugin name: ${plugin.name}`,
        });
      }
      pluginNames.add(plugin.name);

      for (const tool of Object.values(plugin.toolkit?.tools ?? {})) {
        if (toolNames.has(tool.name)) {
          return yield* new DefinitionError({ message: `Duplicate Tool name: ${tool.name}` });
        }
        toolNames.add(tool.name);
        if (toolRequiresHandler(tool)) requiredHandlerNames.add(tool.name);
      }

      for (const name of Object.keys(plugin.handlers ?? {})) {
        if (handlerNames.has(name)) {
          return yield* new DefinitionError({
            message: `Duplicate Tool handler name: ${name}`,
          });
        }
        handlerNames.add(name);
      }
    }

    for (const name of requiredHandlerNames) {
      if (!handlerNames.has(name)) {
        return yield* new DefinitionError({ message: `Missing Tool handler: ${name}` });
      }
    }
    for (const name of handlerNames) {
      if (!toolNames.has(name)) {
        return yield* new DefinitionError({
          message: `Tool handler has no matching Tool: ${name}`,
        });
      }
    }
  });
