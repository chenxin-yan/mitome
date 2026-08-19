import { Effect, Predicate, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import type { AnyExtension, ToolInputValidator, ToolResultValidator } from "./extension.js";
import { getProviderMetadata, parseQualifiedModelId } from "./provider.js";
import type { AnyProvider, QualifiedModelId } from "./provider.js";

export interface AgentDefinition<
  Providers extends ReadonlyArray<AnyProvider> = ReadonlyArray<AnyProvider>,
  DefaultModel extends QualifiedModelId<Providers[number]> = QualifiedModelId<Providers[number]>,
  Extensions extends ReadonlyArray<AnyExtension> = ReadonlyArray<AnyExtension>,
> {
  readonly providers: Providers;
  readonly model: DefaultModel;
  readonly extensions: Extensions;
}

type AnyToolHandler = (params: unknown) => Effect.Effect<unknown, unknown, any>;

export interface CompiledTool {
  readonly tool: Tool.Any;
  readonly owner: AnyExtension;
  readonly handler: AnyToolHandler | undefined;
  readonly inputValidator: ToolInputValidator | undefined;
  readonly resultValidator: ToolResultValidator | undefined;
}

export interface CompiledAgent {
  readonly extensions: ReadonlyArray<AnyExtension>;
  readonly providers: ReadonlyMap<string, AnyProvider>;
  readonly tools: ReadonlyMap<string, CompiledTool>;
  readonly instructions: string;
}

export class AgentDefinitionError extends Schema.TaggedError<AgentDefinitionError>()(
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
  const Extensions extends ReadonlyArray<AnyExtension>,
>(
  definition: {
    readonly providers: Providers;
    readonly model: DefaultModel;
    readonly extensions: Extensions;
  } & ([Providers[number]] extends [AnyProvider] ? unknown : never),
): AgentDefinition<Extract<Providers, ReadonlyArray<AnyProvider>>, DefaultModel, Extensions>;
export function defineAgent(definition: AgentDefinition): AgentDefinition {
  return definition;
}

interface CompiledExtensions {
  readonly extensions: Array<AnyExtension>;
  readonly tools: Map<string, Omit<CompiledTool, "handler">>;
  readonly handlers: Map<string, AnyToolHandler>;
  readonly instructions: Array<string>;
  readonly requiredHandlerNames: Set<string>;
}

const compileExtensions = (extensionValues: unknown, issues: Array<string>): CompiledExtensions => {
  const extensions: Array<AnyExtension> = [];
  const tools = new Map<string, Omit<CompiledTool, "handler">>();
  const handlers = new Map<string, AnyToolHandler>();
  const instructions: Array<string> = [];
  const requiredHandlerNames = new Set<string>();

  if (!Array.isArray(extensionValues)) {
    issues.push("Agent Definition Extensions must be an array");
    return { extensions, tools, handlers, instructions, requiredHandlerNames };
  }

  const graphIssues: Array<string> = [];
  const encountered: Array<AnyExtension> = [];
  const discovered = new WeakSet<object>();
  const extensionsByName = new Map<string, AnyExtension>();
  const conflictingNames = new Set<string>();
  const hasName = (value: unknown): value is { readonly name: string } =>
    Predicate.isObject(value) && typeof value.name === "string";

  // ponytail: recursive discover/visit overflow the call stack on dependency
  // chains thousands deep; switch to an explicit stack if generated graphs need it.
  const discover = (value: unknown, location: string): void => {
    if (!hasName(value)) {
      graphIssues.push(`${location} must be an object with a string name`);
      return;
    }
    if (discovered.has(value)) return;
    discovered.add(value);

    const extension = value as unknown as AnyExtension;
    encountered.push(extension);
    const existing = extensionsByName.get(extension.name);
    if (existing === undefined) {
      extensionsByName.set(extension.name, extension);
    } else if (existing !== extension && !conflictingNames.has(extension.name)) {
      conflictingNames.add(extension.name);
      graphIssues.push(`Conflicting Extension name: ${extension.name} refers to different values`);
    }

    if (extension.dependencies === undefined) return;
    if (!Array.isArray(extension.dependencies)) {
      graphIssues.push(`Extension ${extension.name} Dependencies must be an array`);
      return;
    }
    for (const [index, dependency] of extension.dependencies.entries()) {
      discover(dependency, `Extension dependency ${extension.name}[${index}]`);
    }
  };

  for (const [index, value] of extensionValues.entries()) {
    discover(value, `Extension at index ${index}`);
  }

  const states = new Map<AnyExtension, "visiting" | "visited">();
  const stack: Array<AnyExtension> = [];
  const cycles = new Set<string>();
  const visit = (extension: AnyExtension): void => {
    const state = states.get(extension);
    if (state === "visited") return;
    if (state === "visiting") {
      const start = stack.indexOf(extension);
      const path = [...stack.slice(start), extension].map(({ name }) => name).join(" -> ");
      if (!cycles.has(path)) {
        cycles.add(path);
        graphIssues.push(`Extension dependency cycle: ${path}`);
      }
      return;
    }

    states.set(extension, "visiting");
    stack.push(extension);
    if (Array.isArray(extension.dependencies)) {
      for (const dependency of extension.dependencies) {
        if (!hasName(dependency)) continue;
        const canonical = extensionsByName.get(dependency.name);
        if (canonical !== undefined) visit(canonical);
      }
    }
    stack.pop();
    states.set(extension, "visited");
    extensions.push(extension);
  };

  for (const value of extensionValues) {
    if (!hasName(value)) continue;
    const canonical = extensionsByName.get(value.name);
    if (canonical !== undefined) visit(canonical);
  }
  issues.push(...graphIssues);

  // Invalid graphs still validate every distinct value so one compilation reports
  // graph and contribution problems together. Successful graphs compile in resolved order.
  for (const extension of graphIssues.length === 0 ? extensions : encountered) {
    if (extension.instructions !== undefined && typeof extension.instructions !== "string") {
      issues.push(`Extension ${extension.name} Instructions must be a string`);
    }
    if (typeof extension.instructions === "string" && extension.instructions.length > 0) {
      instructions.push(extension.instructions);
    }

    for (const tool of Object.values(extension.toolkit?.tools ?? {})) {
      if (tools.has(tool.name)) {
        issues.push(`Duplicate Tool name: ${tool.name}`);
      }
      tools.set(tool.name, {
        tool,
        owner: extension,
        inputValidator: undefined,
        resultValidator: undefined,
      });
      if (Tool.isProviderDefined(tool) ? tool.requiresHandler : true) {
        requiredHandlerNames.add(tool.name);
      }
    }

    for (const [name, validator] of Object.entries(extension.toolInputValidators ?? {})) {
      const compiledTool = tools.get(name);
      if (compiledTool === undefined || compiledTool.owner !== extension) {
        issues.push(`Tool input validator has no matching Tool: ${name}`);
      } else {
        tools.set(name, { ...compiledTool, inputValidator: validator });
      }
    }

    for (const [name, validator] of Object.entries(extension.toolResultValidators ?? {})) {
      const compiledTool = tools.get(name);
      if (compiledTool === undefined || compiledTool.owner !== extension) {
        issues.push(`Tool result validator has no matching Tool: ${name}`);
      } else {
        tools.set(name, { ...compiledTool, resultValidator: validator });
      }
    }

    for (const [name, handler] of Object.entries(extension.handlers ?? {})) {
      if (handlers.has(name)) {
        issues.push(`Duplicate Tool handler name: ${name}`);
      }
      handlers.set(name, handler);
    }
  }

  return { extensions, tools, handlers, instructions, requiredHandlerNames };
};

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

  const { extensions, tools, handlers, instructions, requiredHandlerNames } = compileExtensions(
    definition.extensions,
    issues,
  );

  for (const name of requiredHandlerNames) {
    if (!handlers.has(name)) {
      issues.push(`Missing Tool handler: ${name}`);
    }
  }
  for (const name of handlers.keys()) {
    if (!tools.has(name)) {
      issues.push(`Tool handler has no matching Tool: ${name}`);
    }
  }

  if (issues.length > 0) {
    return yield* new AgentDefinitionError({
      issues: issues as [string, ...Array<string>],
    });
  }

  return {
    extensions,
    providers,
    tools: new Map(
      Array.from(tools, ([name, compiledTool]) => [
        name,
        { ...compiledTool, handler: handlers.get(name) },
      ]),
    ),
    instructions: instructions.join("\n\n"),
  };
});
