import { Effect, Predicate, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import type { AnyPlugin, ToolInputValidator, ToolResultValidator } from "./plugin.js";
import { getProviderMetadata, parseQualifiedModelId } from "./provider.js";
import type { AnyProvider, QualifiedModelId } from "./provider.js";

export interface AgentDefinition<
  Providers extends ReadonlyArray<AnyProvider> = ReadonlyArray<AnyProvider>,
  DefaultModel extends QualifiedModelId<Providers[number]> = QualifiedModelId<Providers[number]>,
  Plugins extends ReadonlyArray<AnyPlugin> = ReadonlyArray<AnyPlugin>,
> {
  readonly providers: Providers;
  readonly model: DefaultModel;
  readonly plugins: Plugins;
}

type AnyToolHandler = (params: unknown) => Effect.Effect<unknown, unknown, any>;

export interface CompiledAgent {
  readonly plugins: ReadonlyArray<AnyPlugin>;
  readonly providers: ReadonlyMap<string, AnyProvider>;
  readonly defaultModel: { readonly providerId: string; readonly modelId: string };
  readonly tools: Readonly<Record<string, Tool.Any>>;
  readonly toolOwners: ReadonlyMap<string, AnyPlugin>;
  readonly handlers: Readonly<Record<string, AnyToolHandler>>;
  readonly toolInputValidators: Readonly<Record<string, ToolInputValidator>>;
  readonly toolResultValidators: Readonly<Record<string, ToolResultValidator>>;
  readonly instructions: string;
}

export class AgentDefinitionError extends Schema.TaggedErrorClass<AgentDefinitionError>()(
  "AgentDefinitionError",
  { issues: Schema.NonEmptyArray(Schema.String) },
) {
  override get message(): string {
    return this.issues.join("\n");
  }
}

export function defineAgent<
  const Providers extends ReadonlyArray<unknown>,
  const DefaultModel extends QualifiedModelId<Extract<NoInfer<Providers[number]>, AnyProvider>>,
  const Plugins extends ReadonlyArray<AnyPlugin>,
>(
  definition: {
    readonly providers: Providers;
    readonly model: DefaultModel;
    readonly plugins: Plugins;
  } & ([Providers[number]] extends [AnyProvider] ? unknown : never),
): AgentDefinition<Extract<Providers, ReadonlyArray<AnyProvider>>, DefaultModel, Plugins>;
export function defineAgent(definition: AgentDefinition): AgentDefinition {
  return definition;
}

export const compileAgentDefinition: (
  definition: unknown,
) => Effect.Effect<CompiledAgent, AgentDefinitionError> = Effect.fn(
  "@mitome/core/compileAgentDefinition",
)(function* (definition) {
  if (!Predicate.isObject(definition)) {
    return yield* new AgentDefinitionError({ issues: ["Agent Definition must be an object"] });
  }
  const issues: Array<string> = [];

  const providers = new Map<string, AnyProvider>();
  const providerValues = definition.providers;
  if (!Array.isArray(providerValues)) {
    issues.push("Agent Definition Providers must be an array");
  } else {
    for (const [index, value] of providerValues.entries()) {
      if (!Predicate.isObject(value) || typeof value.id !== "string") {
        issues.push(`Provider at index ${index} must be an object with a string id`);
        continue;
      }
      const provider = value as unknown as AnyProvider;
      if (providers.has(provider.id)) {
        issues.push(`Duplicate Provider id: ${provider.id}`);
      }
      providers.set(provider.id, provider);
      if (getProviderMetadata(provider) === undefined) {
        return yield* Effect.die(new Error("Provider was not created by @mitome/core"));
      }
    }
  }

  let defaultModel: ReturnType<typeof parseQualifiedModelId>;
  const model = definition.model;
  if (typeof model !== "string") {
    issues.push("Agent Definition Model must be a string");
  } else {
    defaultModel = parseQualifiedModelId(model);
    if (defaultModel === undefined) {
      issues.push(`Malformed Qualified Model id: ${model}`);
    } else if (!providers.has(defaultModel.providerId)) {
      issues.push(`Unregistered Provider id: ${defaultModel.providerId}`);
    }
  }

  const plugins: Array<AnyPlugin> = [];
  const tools: Record<string, Tool.Any> = {};
  const toolOwners = new Map<string, AnyPlugin>();
  const handlers: Record<string, AnyToolHandler> = {};
  const toolInputValidators: Record<string, ToolInputValidator> = {};
  const toolResultValidators: Record<string, ToolResultValidator> = {};
  const instructions: Array<string> = [];
  const pluginNames = new Set<string>();
  const toolNames = new Set<string>();
  const handlerNames = new Set<string>();
  const requiredHandlerNames = new Set<string>();
  const pluginValues = definition.plugins;

  if (!Array.isArray(pluginValues)) {
    issues.push("Agent Definition Plugins must be an array");
  } else {
    for (const [index, value] of pluginValues.entries()) {
      if (!Predicate.isObject(value) || typeof value.name !== "string") {
        issues.push(`Plugin at index ${index} must be an object with a string name`);
        continue;
      }
      const plugin = value as unknown as AnyPlugin;
      if (plugin.instructions !== undefined && typeof plugin.instructions !== "string") {
        issues.push(`Plugin ${plugin.name} Instructions must be a string`);
      }
      if (pluginNames.has(plugin.name)) {
        issues.push(`Duplicate Plugin name: ${plugin.name}`);
      }
      pluginNames.add(plugin.name);
      plugins.push(plugin);
      if (typeof plugin.instructions === "string" && plugin.instructions.length > 0) {
        instructions.push(plugin.instructions);
      }

      const pluginToolNames = new Set<string>();
      for (const tool of Object.values(plugin.toolkit?.tools ?? {})) {
        if (toolNames.has(tool.name)) {
          issues.push(`Duplicate Tool name: ${tool.name}`);
        }
        toolNames.add(tool.name);
        pluginToolNames.add(tool.name);
        tools[tool.name] = tool;
        toolOwners.set(tool.name, plugin);
        if (Tool.isProviderDefined(tool) ? tool.requiresHandler : true) {
          requiredHandlerNames.add(tool.name);
        }
      }

      for (const [name, validator] of Object.entries(plugin.toolInputValidators ?? {})) {
        if (!pluginToolNames.has(name)) {
          issues.push(`Tool input validator has no matching Tool: ${name}`);
        }
        toolInputValidators[name] = validator;
      }

      for (const [name, validator] of Object.entries(plugin.toolResultValidators ?? {})) {
        if (!pluginToolNames.has(name)) {
          issues.push(`Tool result validator has no matching Tool: ${name}`);
        }
        toolResultValidators[name] = validator;
      }

      for (const [name, handler] of Object.entries(plugin.handlers ?? {})) {
        if (handlerNames.has(name)) {
          issues.push(`Duplicate Tool handler name: ${name}`);
        }
        handlerNames.add(name);
        handlers[name] = handler;
      }
    }
  }

  for (const name of requiredHandlerNames) {
    if (!handlerNames.has(name)) {
      issues.push(`Missing Tool handler: ${name}`);
    }
  }
  for (const name of handlerNames) {
    if (!toolNames.has(name)) {
      issues.push(`Tool handler has no matching Tool: ${name}`);
    }
  }

  if (issues.length > 0) {
    return yield* new AgentDefinitionError({
      issues: issues as [string, ...Array<string>],
    });
  }

  return {
    plugins,
    providers,
    // Empty `issues` implies the model parsed and resolved, so `defaultModel` is set.
    defaultModel: defaultModel!,
    tools,
    toolOwners,
    handlers,
    toolInputValidators,
    toolResultValidators,
    instructions: instructions.join("\n\n"),
  };
});
