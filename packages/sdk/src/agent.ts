// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file */
import { Schema } from "effect";
import {
  defineAgent as defineCoreAgent,
  type AgentDefinition,
  type AnyExtension,
  type AnyProvider,
  type ApprovalPolicy,
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

type ExtensionsWithTools<
  Extensions extends ReadonlyArray<AnyExtension>,
  Tools extends ReadonlyArray<AnyTool>,
> = readonly [...Extensions, Extension<never, unknown, ToolContributionsOf<Tools>>];

/**
 * Declares an Agent from its Providers, Default Model, and optional Extensions. The Default Model
 * is a Qualified Model id (`provider/model`) whose prefix must name a registered Provider; catalog
 * ids are offered as completions but any model id under that Provider is accepted. `approvals`
 * offers the Extensions' Tool names as completions; see `ApprovalPolicy`.
 */
export function defineAgent<
  const Providers extends ReadonlyArray<AnyProvider>,
  const DefaultModel extends QualifiedModelId<NoInfer<Providers[number]>>,
  const Extensions extends ReadonlyArray<AnyExtension> = readonly [],
>(
  definition: BaseDefinition<Providers, DefaultModel, Extensions> & {
    readonly tools?: undefined;
    readonly approvals?: ApprovalPolicy<NoInfer<Extensions>> | undefined;
  },
): AgentDefinition<Providers, DefaultModel, Extensions>;
/**
 * Declares an Agent with one-off Tools that need no Resource. The `tools` builder becomes an
 * anonymous Extension appended after `extensions`; use `defineExtension` when Tools need a
 * Resource, Hooks, Instructions, or reuse. An `approvals` callback narrows `params` by inline
 * Tool name only when it is written after `tools`; rule lists complete inline names in any order.
 */
export function defineAgent<
  const Providers extends ReadonlyArray<AnyProvider>,
  const DefaultModel extends QualifiedModelId<NoInfer<Providers[number]>>,
  const Extensions extends ReadonlyArray<AnyExtension> = readonly [],
  const Tools extends ReadonlyArray<AnyTool> = readonly [],
>(
  definition: BaseDefinition<Providers, DefaultModel, Extensions> & {
    readonly tools: (scope: { readonly tool: ToolBuilder<never> }) => Tools;
    readonly approvals?:
      | ApprovalPolicy<NoInfer<ExtensionsWithTools<Extensions, Tools>>>
      | undefined;
  },
): AgentDefinition<Providers, DefaultModel, ExtensionsWithTools<Extensions, Tools>>;
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
