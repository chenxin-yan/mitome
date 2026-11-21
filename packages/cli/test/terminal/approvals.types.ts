// Compile-only: a pending request's decision needs nothing, cannot fail, and answers only whether
// it was accepted.
import type { Effect, Types } from "effect";
import type { PendingApproval } from "../../src/terminal/approvals.ts";

const exact = <X, Y>(equal: Types.Equals<X, Y>) => equal;

type Decision = ReturnType<PendingApproval["decide"]>;

export const contracts = [
  exact<Effect.Services<Decision>, never>(true),
  exact<Effect.Error<Decision>, never>(true),
  exact<Effect.Success<Decision>, "accepted" | "stale">(true),
];
