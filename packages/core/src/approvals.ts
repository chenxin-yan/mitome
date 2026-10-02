import { Deferred, Effect } from "effect";
import { Turn } from "./session/session.js";

/** One local decision on a pending Tool Call. */
export type ApprovalDecision = "approve" | "deny";

/** A Tool Call waiting for consent, exactly as policy and consent saw it. */
export interface PendingApproval {
  /** The waiting Turn, for presentation; it is not authority. */
  readonly turnId: string;
  readonly toolCallId: string;
  readonly name: string;
  /** The once-decoded parameters the handler receives if the call is approved. */
  readonly params: unknown;
  /**
   * Resolves this request once. A decision after another was accepted, or after the consent wait
   * ended (the Turn was interrupted or released), is `stale` and changes nothing.
   */
  readonly decide: (decision: ApprovalDecision) => Effect.Effect<"accepted" | "stale">;
}

/** The decision side of `Approvals`: what an application grants a local terminal. */
export interface ApprovalChannel {
  /** Requests still waiting, oldest first. Reading resolves, cancels or runs nothing. */
  readonly pending: Effect.Effect<ReadonlyArray<PendingApproval>>;
}

/** A process-local Approval channel for one application. */
export interface Approvals extends ApprovalChannel {
  /**
   * A `consent` callback for `step` and `loop`: publishes the exact call and waits for one
   * decision, `true` only when it is approved. The wait ends with the Turn; nothing is decided
   * for it then.
   */
  readonly consent: (call: {
    readonly toolCallId: string;
    readonly name: string;
    readonly params: unknown;
  }) => Effect.Effect<boolean, never, Turn>;
}

/**
 * Allocates an Approval channel. Each pending request's own `decide` is its only resolution
 * capability: knowing its Tool-call id or Turn id resolves nothing. Granting `pending` to a
 * terminal is the authorization this process-local channel has; it is no isolation from other
 * code running in the same process.
 */
export const makeApprovals: Effect.Effect<Approvals> = Effect.sync(() => {
  const waiting = new Set<PendingApproval>();
  return {
    pending: Effect.sync(() => [...waiting]),
    consent: (call) =>
      Effect.gen(function* () {
        const turn = yield* Turn;
        const decided = yield* Deferred.make<boolean>();
        const request: PendingApproval = {
          turnId: turn.id,
          toolCallId: call.toolCallId,
          name: call.name,
          params: call.params,
          decide: (decision) =>
            Effect.sync(() => {
              if (!waiting.delete(request)) return "stale";
              Deferred.doneUnsafe(decided, Effect.succeed(decision === "approve"));
              return "accepted";
            }),
        };
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => void waiting.add(request)),
          () => Deferred.await(decided),
          () => Effect.sync(() => void waiting.delete(request)),
        );
      }),
  };
});
