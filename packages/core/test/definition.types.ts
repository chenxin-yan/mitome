// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file */
import { Context, Effect } from "effect";
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

const dependent = Tool.make("dependent", { dependencies: [Dependency] });
definePlugin({
  name: "dependent",
  toolkit: Toolkit.make(dependent),
  handlers: {
    // @ts-expect-error Tool service dependencies require a Plugin resource Layer.
    dependent: () => Effect.map(Dependency, ({ value }) => value),
  },
});
