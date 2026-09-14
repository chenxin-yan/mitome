import type { ApprovalResolutionError, RouteKey } from "@mitome/core";
import { Effect, Scope } from "effect";

/** One live Approval a Channel is waiting on; `key` is the Route whose Turn asked. */
export interface PendingApproval {
  /** Only this Route's principal may decide, and a chat surface also requires this conversation. */
  readonly key: RouteKey;
  readonly approve: () => Effect.Effect<void, ApprovalResolutionError>;
  readonly deny: (reason?: string) => Effect.Effect<void, ApprovalResolutionError>;
}

/** In-memory registry of pending Approvals keyed by a Channel-chosen id; see {@link createPendingApprovals}. */
export interface PendingApprovals {
  /** Stable, Model-visible reason a Channel in `"deny"` mode answers every pending Approval with. */
  readonly defaultDenial: string;
  /**
   * Registers the entry until it is taken, the Turn's `scope` closes, or `timeoutMs` elapses and
   * it is denied with the timeout reason. The timer is forked in `scope`, so an interrupted Turn
   * leaves no timer behind and forgets its entries.
   */
  readonly register: (
    id: string,
    entry: PendingApproval,
    scope: Scope.Scope,
  ) => Effect.Effect<void>;
  /** Reads an entry without deciding it, so the caller can check who is asking first. */
  readonly peek: (id: string) => PendingApproval | undefined;
  /** Removes and returns the entry; a second take of the same id is `undefined`, so a decision never applies twice. */
  readonly take: (id: string) => PendingApproval | undefined;
}

/**
 * Pending Approvals live in the process for the lifetime of their Turn only. `kind` and `name`
 * identify the Channel in the denial reasons; an unanswered Approval is denied after `timeoutMs`
 * (default 5 minutes).
 */
export const createPendingApprovals = (
  kind: "http" | "telegram",
  name: string,
  timeoutMs = 300_000,
): PendingApprovals => {
  const timeoutReason = `Approval denied: the ${kind} Channel "${name}" received no decision before the Approval timed out`;
  const pending = new Map<string, PendingApproval>();
  const take = (id: string): PendingApproval | undefined => {
    const entry = pending.get(id);
    pending.delete(id);
    return entry;
  };
  return {
    defaultDenial: `Approval denied: the ${kind} Channel "${name}" does not resolve Approvals (set approvals: "interactive" or list the Tool under approvals.allow)`,
    register: (id, entry, scope) =>
      Effect.gen(function* () {
        pending.set(id, entry);
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            pending.delete(id);
          }),
        );
        yield* Effect.suspend(() => {
          const timedOut = take(id);
          return timedOut === undefined ? Effect.void : Effect.ignore(timedOut.deny(timeoutReason));
        }).pipe(Effect.delay(timeoutMs), Effect.forkIn(scope));
      }),
    peek: (id) => pending.get(id),
    take,
  };
};
