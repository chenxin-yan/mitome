import { Approver } from "@mitome/core";
import type { ApprovalDecision, ApprovalRequest, ApproverService } from "@mitome/core";
import { Deferred, Effect } from "effect";

/** A Tool Call waiting for the person's answer, as the Model sent it. */
export interface PendingApproval extends ApprovalRequest {
  /**
   * Resolves this request once. A decision after another was accepted, or after the wait ended
   * (the Turn was interrupted or released), is `stale` and changes nothing.
   */
  readonly decide: (decision: ApprovalDecision) => Effect.Effect<"accepted" | "stale">;
}

/** The decision side of `Approvals`: what the terminal view reads. */
export interface ApprovalChannel {
  /** Requests still waiting, oldest first. Reading resolves, cancels or runs nothing. */
  readonly pending: Effect.Effect<ReadonlyArray<PendingApproval>>;
}

/** The terminal's process-local Approval channel. */
export interface Approvals extends ApprovalChannel {
  /**
   * Runs one Turn with its own `Approver`, which publishes the exact call and waits for one
   * decision. It never fails. When the Turn ends, even with a Step it started still asking, that
   * Approver is revoked: its requests are withdrawn, their waits are interrupted and any later ask
   * is interrupted at once. Nothing is decided for them.
   */
  readonly provideApprover: <A, E, R>(turn: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/**
 * Allocates an Approval channel. Each pending request's own `decide` is its only resolution
 * capability: knowing its Tool-call id or Turn id resolves nothing. Granting `pending` to the
 * terminal is the authorization this process-local channel has; it is no isolation from other
 * code running in the same process.
 */
export const makeApprovals: Effect.Effect<Approvals> = Effect.sync(() => {
  const waiting = new Set<PendingApproval>();
  return {
    pending: Effect.sync(() => [...waiting]),
    provideApprover: (turn) =>
      Effect.suspend(() => {
        // This Turn's waits; a detached Step's wait would otherwise outlive the Turn.
        const asking = new Map<PendingApproval, Deferred.Deferred<ApprovalDecision>>();
        let revoked = false;
        const approver: ApproverService = {
          decide: Effect.fnUntraced(function* (call) {
            const decided = yield* Deferred.make<ApprovalDecision>();
            const request: PendingApproval = {
              turnId: call.turnId,
              toolCallId: call.toolCallId,
              name: call.name,
              params: call.params,
              decide: (decision) =>
                Effect.sync(() => {
                  if (!waiting.delete(request)) {
                    return "stale";
                  }
                  Deferred.doneUnsafe(decided, Effect.succeed(decision));
                  return "accepted";
                }),
            };
            return yield* Effect.acquireUseRelease(
              // Checked in the same synchronous step that publishes, so a Turn that ends while
              // this ask is starting cannot miss the request and leave it answerable.
              Effect.sync(() => {
                if (revoked) {
                  return false;
                }
                waiting.add(request);
                asking.set(request, decided);
                return true;
              }),
              (published) => (published ? Deferred.await(decided) : Effect.interrupt),
              () =>
                Effect.sync(() => {
                  waiting.delete(request);
                  asking.delete(request);
                }),
            );
          }),
        };
        return turn.pipe(
          Effect.provideService(Approver, approver),
          Effect.ensuring(
            Effect.suspend(() => {
              revoked = true;
              const withdrawn = [...asking];
              for (const [request] of withdrawn) {
                waiting.delete(request);
              }
              return Effect.forEach(withdrawn, ([, decided]) => Deferred.interrupt(decided), {
                discard: true,
              });
            }),
          ),
        );
      }),
  };
});
