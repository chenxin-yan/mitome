import { Effect, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import type { Model } from "./model.js";
import type { AnyPlugin } from "./plugin.js";

export interface AgentDefinition {
  readonly model: Model;
  readonly plugins: ReadonlyArray<AnyPlugin>;
}

export class AgentDefinitionError extends Schema.TaggedErrorClass<AgentDefinitionError>()(
  "AgentDefinitionError",
  { message: Schema.String },
) {}

export const defineAgent = <const Value extends AgentDefinition>(
  definition: Value & Record<Exclude<keyof Value, keyof AgentDefinition>, never>,
): Value => definition;

const toolRequiresHandler = (tool: Tool.Any): boolean =>
  Tool.isProviderDefined(tool) ? tool.requiresHandler : true;

export const validateAgentDefinition: (
  definition: AgentDefinition,
) => Effect.Effect<void, AgentDefinitionError> = Effect.fn("@mitome/core/validateAgentDefinition")(
  function* (definition) {
    const pluginNames = new Set<string>();
    const toolNames = new Set<string>();
    const handlerNames = new Set<string>();
    const requiredHandlerNames = new Set<string>();

    for (const plugin of definition.plugins) {
      if (pluginNames.has(plugin.name)) {
        return yield* new AgentDefinitionError({
          message: `Duplicate Plugin name: ${plugin.name}`,
        });
      }
      pluginNames.add(plugin.name);

      const pluginToolNames = new Set<string>();
      for (const tool of Object.values(plugin.toolkit?.tools ?? {})) {
        if (toolNames.has(tool.name)) {
          return yield* new AgentDefinitionError({ message: `Duplicate Tool name: ${tool.name}` });
        }
        toolNames.add(tool.name);
        pluginToolNames.add(tool.name);
        if (toolRequiresHandler(tool)) requiredHandlerNames.add(tool.name);
      }

      for (const name of Object.keys(plugin.toolInputValidators ?? {})) {
        if (!pluginToolNames.has(name)) {
          return yield* new AgentDefinitionError({
            message: `Tool input validator has no matching Tool: ${name}`,
          });
        }
      }

      for (const name of Object.keys(plugin.toolResultValidators ?? {})) {
        if (!pluginToolNames.has(name)) {
          return yield* new AgentDefinitionError({
            message: `Tool result validator has no matching Tool: ${name}`,
          });
        }
      }

      for (const name of Object.keys(plugin.handlers ?? {})) {
        if (handlerNames.has(name)) {
          return yield* new AgentDefinitionError({
            message: `Duplicate Tool handler name: ${name}`,
          });
        }
        handlerNames.add(name);
      }
    }

    for (const name of requiredHandlerNames) {
      if (!handlerNames.has(name)) {
        return yield* new AgentDefinitionError({ message: `Missing Tool handler: ${name}` });
      }
    }
    for (const name of handlerNames) {
      if (!toolNames.has(name)) {
        return yield* new AgentDefinitionError({
          message: `Tool handler has no matching Tool: ${name}`,
        });
      }
    }
  },
);
