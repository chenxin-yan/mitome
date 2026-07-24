import { Effect, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import type { Model } from "./model.js";
import type { AnyPlugin } from "./plugin.js";
import { getProviderMetadata, parseModelIdentifier } from "./provider.js";
import type { AnyProvider, ModelIdentifier } from "./provider.js";

export interface LegacyAgentDefinition<
  Plugins extends ReadonlyArray<AnyPlugin> = ReadonlyArray<AnyPlugin>,
> {
  readonly model: Model;
  readonly plugins: Plugins;
}

export interface ProviderAgentDefinition<
  Providers extends ReadonlyArray<AnyProvider> = ReadonlyArray<AnyProvider>,
  DefaultModel extends ModelIdentifier<Providers[number]> = ModelIdentifier<Providers[number]>,
  Plugins extends ReadonlyArray<AnyPlugin> = ReadonlyArray<AnyPlugin>,
> {
  readonly providers: Providers;
  readonly model: DefaultModel;
  readonly plugins: Plugins;
}

export type AgentDefinition<Plugins extends ReadonlyArray<AnyPlugin> = ReadonlyArray<AnyPlugin>> =
  | LegacyAgentDefinition<Plugins>
  | ProviderAgentDefinition<ReadonlyArray<AnyProvider>, ModelIdentifier<AnyProvider>, Plugins>;

export class AgentDefinitionError extends Schema.TaggedErrorClass<AgentDefinitionError>()(
  "AgentDefinitionError",
  { message: Schema.String },
) {}

export function defineAgent<
  const Providers extends ReadonlyArray<unknown>,
  const DefaultModel extends ModelIdentifier<Extract<NoInfer<Providers[number]>, AnyProvider>>,
  const Plugins extends ReadonlyArray<AnyPlugin>,
>(
  definition: {
    readonly providers: Providers;
    readonly model: DefaultModel;
    readonly plugins: Plugins;
  } & ([Providers[number]] extends [AnyProvider] ? unknown : never),
): ProviderAgentDefinition<Extract<Providers, ReadonlyArray<AnyProvider>>, DefaultModel, Plugins>;
export function defineAgent<const Value extends AgentDefinition>(
  definition: Value &
    ("providers" extends keyof Value
      ? never
      : Record<Exclude<keyof Value, "model" | "plugins">, never>),
): Value;
export function defineAgent(definition: AgentDefinition): AgentDefinition {
  return definition;
}

export const isProviderAgentDefinition = (
  definition: AgentDefinition,
): definition is ProviderAgentDefinition => "providers" in definition;

const toolRequiresHandler = (tool: Tool.Any): boolean =>
  Tool.isProviderDefined(tool) ? tool.requiresHandler : true;

export const validateAgentDefinition: (
  definition: AgentDefinition,
) => Effect.Effect<void, AgentDefinitionError> = Effect.fn("@mitome/core/validateAgentDefinition")(
  function* (definition) {
    if ("instructions" in definition) {
      return yield* new AgentDefinitionError({
        message: "Agent Definition Instructions must be contributed by Plugins",
      });
    }

    if (isProviderAgentDefinition(definition)) {
      const providerIds = new Set<string>();
      for (const provider of definition.providers) {
        if (providerIds.has(provider.id)) {
          return yield* new AgentDefinitionError({
            message: `Duplicate Provider id: ${provider.id}`,
          });
        }
        providerIds.add(provider.id);
        if (getProviderMetadata(provider) === undefined) {
          return yield* Effect.die(new Error("Provider was not created by @mitome/core"));
        }
      }

      const selection = parseModelIdentifier(definition.model);
      if (selection === undefined) {
        return yield* new AgentDefinitionError({
          message: `Malformed Model identifier: ${definition.model}`,
        });
      }
      if (!providerIds.has(selection.providerId)) {
        return yield* new AgentDefinitionError({
          message: `Unregistered Provider id: ${selection.providerId}`,
        });
      }
    }

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
