import {
  ApprovalResolutionError,
  DefinitionError,
  SessionBusyError,
  SessionReleasedError,
  TurnError,
  TurnStepLimitError,
} from "@mitome/sdk";

// #region tagged-errors
export const describeFailure = (error: unknown): string => {
  if (error instanceof SessionBusyError) return "another Turn is active";
  if (error instanceof SessionReleasedError) return "the Session has been released";
  if (error instanceof TurnStepLimitError) return "the Turn exceeded 16 Steps";
  if (error instanceof TurnError) return `the Session or Turn failed: ${error.message}`;
  if (error instanceof DefinitionError) return `the Definition is invalid: ${error.message}`;
  if (error instanceof ApprovalResolutionError) return "the Approval was already resolved";
  throw error;
};
// #endregion tagged-errors
