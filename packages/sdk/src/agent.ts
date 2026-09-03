// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file */
import { Schema } from "effect";
import {
  defineAgent as defineCoreAgent,
  type AgentDefinition,
  type AnyExtension,
  type AnyProvider,
  type Extension,
  type QualifiedModelId,
} from "@mitome/core";
import {
  defineExtension,
  type AnyTool,
  type ToolBuilder,
  type ToolContributionsOf,
} from "./extension.js";

type BaseDefinition<
  Providers extends ReadonlyArray<AnyProvider>,
  DefaultModel extends QualifiedModelId<Providers[number]>,
  Extensions extends ReadonlyArray<AnyExtension>,
> = {
  readonly providers: Providers;
  readonly model: DefaultModel;
  readonly extensions?: Extensions;
};

type RuntimeAgentDefinition = BaseDefinition<
  ReadonlyArray<AnyProvider>,
  `${string}/${string}`,
  ReadonlyArray<AnyExtension>
> & {
  readonly tools?: (scope: { readonly tool: ToolBuilder<never> }) => ReadonlyArray<AnyTool>;
};

export function defineAgent<
  const Providers extends ReadonlyArray<AnyProvider>,
  const DefaultModel extends QualifiedModelId<NoInfer<Providers[number]>>,
  const Extensions extends ReadonlyArray<AnyExtension> = readonly [],
>(
  definition: BaseDefinition<Providers, DefaultModel, Extensions> & { readonly tools?: undefined },
): AgentDefinition<Providers, DefaultModel, Extensions>;
export function defineAgent<
  const Providers extends ReadonlyArray<AnyProvider>,
  const DefaultModel extends QualifiedModelId<NoInfer<Providers[number]>>,
  const Extensions extends ReadonlyArray<AnyExtension> = readonly [],
  const Tools extends ReadonlyArray<AnyTool> = readonly [],
>(
  definition: BaseDefinition<Providers, DefaultModel, Extensions> & {
    readonly tools: (scope: { readonly tool: ToolBuilder<never> }) => Tools;
  },
): AgentDefinition<
  Providers,
  DefaultModel,
  readonly [...Extensions, Extension<never, unknown, ToolContributionsOf<Tools>>]
>;
export function defineAgent(definition: typeof Schema.Unknown.Type): never {
  // SAFETY: overload resolution validates every public call before this erased implementation.
  const { tools, ...agent } = definition as RuntimeAgentDefinition;
  // SAFETY: overloads validate public inputs and expose the precise tuple after this root Tool Extension is appended.
  return defineCoreAgent({
    ...agent,
    extensions:
      tools === undefined
        ? (agent.extensions ?? [])
        : [...(agent.extensions ?? []), defineExtension({ tools })],
  }) as never;
}
