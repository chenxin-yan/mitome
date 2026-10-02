// Compile-only fixture for the CLI Approval channel: the @ts-expect-error lines are the negative
// controls, so the language service's duplicate context/error diagnostics are skipped here.
// oxlint-disable-next-line jsdoc/check-tag-names
/** @effect-diagnostics missingEffectContext:skip-file missingEffectError:skip-file missingLayerContext:skip-file */
import { Context, Effect, Layer, type Scope, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import * as Core from "../src/index.js";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
const exact = <X, Y>(equal: Equal<X, Y>) => equal;

class Channel extends Context.Service<Channel, Core.Approvals>()("fixture/Approvals") {}
class Undeclared extends Context.Service<Undeclared, { readonly n: number }>()(
  "fixture/Undeclared",
) {}
class ChannelError extends Schema.TaggedError<ChannelError>()("ChannelError", {}) {}

const Lookup = Tool.make("lookup", {
  parameters: Schema.Struct({ key: Schema.String }),
  needsApproval: true,
});
const Kit = Toolkit.make(Lookup);
declare const tools: Core.LocalTools<Toolkit.Tools<typeof Kit>>;
declare const approvals: Core.Approvals;
declare const openChannel: Effect.Effect<Core.Approvals, ChannelError, Channel>;

// The channel's `consent` is an ordinary consent callback for a concrete Toolkit.
export const options: Core.StepOptions<Toolkit.Tools<typeof Kit>, Core.Turn> = {
  tools,
  consent: approvals.consent,
};

const infrastructure = Layer.effect(Channel, Core.makeApprovals);

const app = Core.defineMitome({
  program: (input: string) => Effect.as(Channel, input),
  limits: Core.firstPartyExecutionLimits,
  infrastructure,
  cli: {
    parseInput: Effect.succeed,
    renderResult: Effect.succeed,
    approvals: openChannel,
  },
});

type Acquired = Effect.Success<ReturnType<typeof app.acquire>>;
declare const acquired: Acquired;
const granted = acquired.provide(app.cli!.approvals!);
type Pending = Effect.Success<Effect.Success<typeof granted>["pending"]>[number];

export const contracts = [
  // The accessor keeps its own failure; binding it supplies the infrastructure it needs.
  exact<Effect.Error<typeof granted>, ChannelError | Core.ApplicationClosedError>(true),
  exact<Effect.Services<typeof granted>, never>(true),
  exact<Effect.Services<ReturnType<typeof app.acquire>>, Scope.Scope>(true),
  // Pending requests and their decisions need nothing and cannot fail.
  exact<Effect.Services<ReturnType<Pending["decide"]>>, never>(true),
  exact<Effect.Error<ReturnType<Pending["decide"]>>, never>(true),
  exact<Effect.Success<ReturnType<Pending["decide"]>>, "accepted" | "stale">(true),
  // The mappings keep their inferred input and result types.
  exact<Effect.Success<ReturnType<NonNullable<typeof app.cli>["parseInput"]>>, string>(true),
];

Core.defineMitome({
  program: (input: string) => Effect.succeed(input),
  limits: Core.firstPartyExecutionLimits,
  infrastructure,
  cli: {
    parseInput: Effect.succeed,
    renderResult: Effect.succeed,
    // @ts-expect-error The accessor's unsupplied service is not closed by anything.
    approvals: Effect.andThen(Undeclared, Channel),
  },
});

Core.defineMitome({
  program: (input: string) => Effect.succeed(input),
  limits: Core.firstPartyExecutionLimits,
  cli: {
    parseInput: Effect.succeed,
    renderResult: Effect.succeed,
    // @ts-expect-error The channel is supplied only by infrastructure this app lacks.
    approvals: Channel,
  },
});
