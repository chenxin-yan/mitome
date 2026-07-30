import { Effect } from "effect";
import type { Response } from "effect/unstable/ai";
import type { ApprovalResolutionError } from "./errors.js";

export interface ToolExecutionDenied {
  readonly type: "execution-denied";
  readonly reason: string;
}

export type TurnEvent =
  | { readonly type: "model-output"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly params: unknown;
    }
  | {
      readonly type: "tool-result";
      readonly id: string;
      readonly name: string;
      readonly result: unknown;
      readonly isFailure: boolean;
    }
  | {
      readonly type: "approval-required";
      readonly approvalId: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly params: unknown;
      readonly approve: () => Effect.Effect<void, ApprovalResolutionError>;
      readonly deny: (reason?: string) => Effect.Effect<void, ApprovalResolutionError>;
    }
  | {
      readonly type: "response-complete";
      readonly finishReason?: Response.FinishReason;
      readonly usage?: Response.Usage;
    };
