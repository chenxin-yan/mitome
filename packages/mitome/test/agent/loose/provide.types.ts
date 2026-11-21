// Compile-only fixture, also compiled without `exactOptionalPropertyTypes` by
// `provide-loose.test.ts`: `provide`, when written, holds a Layer or a list there too. The lines
// marked to expect an error are the negative controls, so the language service's duplicate
// context diagnostics are skipped here.
// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file */
import { Context, Effect, Layer } from "effect";
import { Agent, Mitome } from "../../../src/index.js";

class Db extends Context.Service<Db, { readonly label: string }>()("fixture/Db") {}

const needy = Agent.make({
  program: (input: string) => Effect.map(Db, ({ label }) => `${label}${input}`),
});

const free = Agent.make({ program: (input: string) => Effect.succeed(input) });
declare const enabled: boolean;

// @ts-expect-error `provide` written holds a Layer or a list, never `undefined`.
Mitome.make({ agent: free, provide: undefined });
// @ts-expect-error Not even when it may be one.
Mitome.make({ agent: free, provide: enabled ? Layer.succeed(Db, { label: "db" }) : undefined });

// Leaving `provide` out provides nothing.
export const bare = Mitome.make({ agent: free });
// @ts-expect-error The program's Db is provided by nothing.
Mitome.make({ agent: needy });

// Layers written in place still count.
export const inline = Mitome.make({ agent: needy, provide: [Layer.succeed(Db, { label: "db" })] });
export const single = Mitome.make({
  agent: needy,
  provide: Layer.sync(Db, () => ({ label: "db" })),
});
