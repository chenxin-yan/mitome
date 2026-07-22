// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file */
import { Context, Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { definePlugin, type AnyPlugin, type Plugin } from "../../src/index.js";

class Dependency extends Context.Service<Dependency, { readonly value: string }>()(
  "@mitome/core/test/Dependency",
) {}

const independent = Tool.make("independent");
definePlugin({
  name: "independent",
  toolkit: Toolkit.make(independent),
  handlers: { independent: () => Effect.void },
});

definePlugin({
  name: "wrong-handler",
  toolkit: Toolkit.make(independent),
  // @ts-expect-error Toolkit handlers must use the Tool's exact name.
  handlers: { wrong: () => Effect.void },
});

// @ts-expect-error A Toolkit requiring a handler cannot omit it.
definePlugin({ name: "missing-handler", toolkit: Toolkit.make(independent), handlers: {} });

const dependent = Tool.make("dependent", { dependencies: [Dependency] });
definePlugin({
  name: "dependent",
  toolkit: Toolkit.make(dependent),
  // @ts-expect-error Tool service dependencies require a Plugin resource Layer.
  handlers: { dependent: () => Effect.map(Dependency, ({ value }) => value) },
});

// AnyPlugin must accept every Plugin parameterization; Layer's contravariant
// ROut vs covariant hook R means neither union arm alone suffices.
declare const resourceful: Plugin<{ readonly db: string }, Error>;
declare const unknownResource: Plugin<unknown, never>;
declare const bare: Plugin;
export const anyPlugins: ReadonlyArray<AnyPlugin> = [resourceful, unknownResource, bare];

const PluginResource = Context.Service<string>("@mitome/core/test/PluginResource");
export const resourcePlugin: Plugin<string> = definePlugin({
  name: "resourceful",
  resource: Layer.succeed(PluginResource, "value"),
  hooks: { sessionStart: Effect.asVoid(Effect.service(PluginResource)) },
});

declare const decodingDependentSchema: Schema.Codec<string, string, Dependency, never>;
const decodingDependent = Tool.make("decoding-dependent", {
  success: decodingDependentSchema,
});
definePlugin({
  name: "decoding-dependent",
  toolkit: Toolkit.make(decodingDependent),
  // @ts-expect-error Tool result decoding services require a Plugin resource Layer.
  handlers: { "decoding-dependent": () => Effect.succeed("result") },
});
