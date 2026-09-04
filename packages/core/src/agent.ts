import { Effect, Predicate, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import type {
  AnyExtension,
  ToolFailureValidator,
  ToolInput,
  ToolInputValidator,
  ToolOutput,
  ToolResultValidator,
} from "./extension.js";
import { isProvider, parseQualifiedModelId } from "./provider.js";
import type { AnyProvider, QualifiedModelId } from "./provider.js";

/**
 * A user-authored declaration of exactly one Agent: its Providers, Default Model, and Extensions.
 * Create it with `defineAgent`; a Session compiles it once when it starts.
 */
export interface AgentDefinition<
  Providers extends ReadonlyArray<AnyProvider> = ReadonlyArray<AnyProvider>,
  DefaultModel extends QualifiedModelId<Providers[number]> = QualifiedModelId<Providers[number]>,
  Extensions extends ReadonlyArray<AnyExtension> = ReadonlyArray<AnyExtension>,
> {
  /** Providers the Agent may select Models from; ids must be unique. */
  readonly providers: Providers;
  /** Default Model as a Qualified Model id (`provider/model`) under a registered Provider. */
  readonly model: DefaultModel;
  /** Extensions in composition order; start Hooks run and Resources are acquired in this order. */
  readonly extensions: Extensions;
}

type AnyToolHandler = (params: ToolInput) => Effect.Effect<ToolOutput, unknown, any>;

/** One Tool after compilation, joined with the Extension that owns it and its validators. */
export interface CompiledTool {
  readonly tool: Tool.Any;
  readonly owner: AnyExtension;
  /** Absent only for provider-executed Tools that need no handler. */
  readonly handler: AnyToolHandler | undefined;
  readonly inputValidator: ToolInputValidator | undefined;
  readonly resultValidator: ToolResultValidator | undefined;
  readonly failureValidator: ToolFailureValidator | undefined;
}

/**
 * The validated form of an Agent Definition that a Session runs: Providers by id, Tools by name,
 * and every Extension's Instructions joined into the system prompt.
 */
export interface CompiledAgent {
  readonly extensions: ReadonlyArray<AnyExtension>;
  readonly providers: ReadonlyMap<string, AnyProvider>;
  readonly tools: ReadonlyMap<string, CompiledTool>;
  readonly instructions: string;
}

/**
 * The Agent Definition cannot compile: duplicate Provider ids, a malformed or unregistered Default
 * Model, conflicting Extension or Tool names, or Tool handlers without a matching Tool. `issues`
 * lists every problem found, not just the first.
 */
export class AgentDefinitionError extends Schema.TaggedError<AgentDefinitionError>()(
  "AgentDefinitionError",
  { issues: Schema.NonEmptyArray(Schema.String) },
) {
  /** Every issue, one per line. */
  override get message(): string {
    return this.issues.join("\n");
  }
}

/**
 * Declares an Agent from its Providers, Default Model, and optional Extensions. The Default Model
 * is checked against the registered Providers' catalogs at the type level while still accepting
 * any `provider/model` id for a registered Provider, because catalogs are hints, not allow-lists.
 */
export function defineAgent<
  const Providers extends ReadonlyArray<unknown>,
  const DefaultModel extends QualifiedModelId<Extract<NoInfer<Providers[number]>, AnyProvider>>,
>(
  definition: {
    readonly providers: Providers;
    readonly model: DefaultModel;
    readonly extensions?: undefined;
  } & ([Providers[number]] extends [AnyProvider] ? unknown : never),
): AgentDefinition<Extract<Providers, ReadonlyArray<AnyProvider>>, DefaultModel, readonly []>;
/** Declares an Agent with Extensions; see the Extension-free overload for the Default Model rules. */
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
export function defineAgent(definition: any): AgentDefinition {
  return {
    ...definition,
    extensions: definition.extensions === undefined ? [] : definition.extensions,
  };
}

interface CompiledExtensions {
  readonly extensions: Array<AnyExtension>;
  readonly tools: Map<string, Omit<CompiledTool, "handler">>;
  readonly handlers: Map<string, AnyToolHandler>;
  readonly instructions: Array<string>;
  readonly requiredHandlerNames: Set<string>;
}

const compileExtensions = (
  extensionValues: typeof Schema.Unknown.Type,
  issues: Array<string>,
): CompiledExtensions => {
  const extensions: Array<AnyExtension> = [];
  const tools = new Map<string, Omit<CompiledTool, "handler">>();
  const handlers = new Map<string, AnyToolHandler>();
  const instructions: Array<string> = [];
  const requiredHandlerNames = new Set<string>();

  if (!Array.isArray(extensionValues)) {
    issues.push("Agent Definition Extensions must be an array");
    return { extensions, tools, handlers, instructions, requiredHandlerNames };
  }

  const discovered = new WeakSet<object>();
  const extensionsByName = new Map<string, AnyExtension>();
  const conflictingNames = new Set<string>();
  for (const [index, value] of extensionValues.entries()) {
    if (
      !Predicate.isObject(value) ||
      (value.name !== undefined && !Predicate.isString(value.name))
    ) {
      issues.push(`Extension at index ${index} must be an object with an optional string name`);
      continue;
    }
    if (discovered.has(value)) continue;
    discovered.add(value);

    // SAFETY: runtime shape validation above established the optional identity field.
    const extension = value as AnyExtension;
    if (extension.name !== undefined) {
      const existing = extensionsByName.get(extension.name);
      if (existing === undefined) {
        extensionsByName.set(extension.name, extension);
      } else if (!conflictingNames.has(extension.name)) {
        conflictingNames.add(extension.name);
        issues.push(`Conflicting Extension name: ${extension.name} refers to different values`);
      }
    }
    extensions.push(extension);
  }

  for (const extension of extensions) {
    const label =
      extension.name === undefined ? "Anonymous Extension" : `Extension ${extension.name}`;
    if (extension.instructions !== undefined && !Predicate.isString(extension.instructions)) {
      issues.push(`${label} Instructions must be a string`);
    }
    if (Predicate.isString(extension.instructions) && extension.instructions.length > 0) {
      instructions.push(extension.instructions);
    }

    for (const tool of Object.values(extension.toolkit?.tools ?? {})) {
      if (tools.has(tool.name)) issues.push(`Duplicate Tool name: ${tool.name}`);
      tools.set(tool.name, {
        tool,
        owner: extension,
        inputValidator: undefined,
        resultValidator: undefined,
        failureValidator: undefined,
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

    for (const [name, validator] of Object.entries(extension.toolFailureValidators ?? {})) {
      const compiledTool = tools.get(name);
      if (compiledTool === undefined || compiledTool.owner !== extension) {
        issues.push(`Tool failure validator has no matching Tool: ${name}`);
      } else {
        tools.set(name, { ...compiledTool, failureValidator: validator });
      }
    }

    for (const [name, handler] of Object.entries(extension.handlers ?? {})) {
      if (handlers.has(name)) issues.push(`Duplicate Tool handler name: ${name}`);
      handlers.set(name, handler);
    }
  }

  return { extensions, tools, handlers, instructions, requiredHandlerNames };
};

/**
 * Validates an unknown value as an Agent Definition and resolves it into a `CompiledAgent`.
 * Sessions call this when they start; a Host may call it earlier to surface
 * `AgentDefinitionError` before opening a Session. A Provider not created by this copy of Core is
 * a defect, not an issue.
 */
export const compileAgentDefinition: (
  definition: typeof Schema.Unknown.Type,
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
      if (!Predicate.isObject(value) || !Predicate.isString(value.id)) {
        issues.push(`Provider at index ${index} must be an object with a string id`);
        continue;
      }
      if (!isProvider(value)) {
        return yield* Effect.die(new Error("Provider was not created by @mitome/core"));
      }
      if (providers.has(value.id)) {
        issues.push(`Duplicate Provider id: ${value.id}`);
      }
      providers.set(value.id, value);
    }
  }

  let defaultModel: ReturnType<typeof parseQualifiedModelId>;
  const model = definition.model;
  if (!Predicate.isString(model)) {
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
      // SAFETY: guarded by issues.length > 0, so the array satisfies Schema.NonEmptyArray.
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
