// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file */
import { Context, Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { definePlugin } from "../src/index.js";

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
