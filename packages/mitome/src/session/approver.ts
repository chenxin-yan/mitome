import { Context, type Effect, type Schema } from "effect";

/** An answer to one pending Approval. */
export type ApprovalDecision = "allow" | "deny";

/** One Tool Call waiting for an answer. */
export interface ApprovalRequest {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly name: string;
  /**
   * The JSON the Model sent for this Tool Call, without fields the Tool does not declare (the handler
   * never receives them either); not the value its schema decodes. It is plain data, JSON as Effect's
   * `Schema.Json` defines it (see `isPlainData`): a response whose Tool Call parameters are not is
   * refused before any gate.
   */
  readonly params: Schema.Json;
}

/** Answers pending Approvals. Only the Tool gate calls it. */
export interface ApproverService {
  /** A failure or defect denies; interruption propagates. */
  readonly decide: (request: ApprovalRequest) => Effect.Effect<ApprovalDecision, unknown>;
}

/**
 * Who answers a pending Approval. A Host provides it; the default is nobody, so every ask is
 * denied with a reason the Model is told. Keyed by a stable string because the CLI and a
 * Configuration may load different copies of this package and must still find each other's.
 */
export const Approver = Context.Reference<ApproverService | undefined>("mitome/Approver", {
  defaultValue: () => undefined,
});
