/**
 * Effect-native Sessions, Turns, controlled Steps, the Provider contract and the Approver.
 *
 * @module @mitome/core
 */

// Namespace modules hold only their public names; internals live in `session/internal.ts`.
export * as Provider from "./session/provider.js";
export {
  ModelRequestAccounting,
  reportModelRequest,
  withModelRequestAccounting,
} from "./session/accounting.js";
export { Approver } from "./session/approver.js";
export type { ApprovalDecision, ApprovalRequest, ApproverService } from "./session/approver.js";
export { CredentialDescriptorSchema } from "./session/credential.js";
export type {
  AuthCapability,
  AuthenticateOptions,
  CredentialDescriptor,
} from "./session/credential.js";
export {
  configDirectory,
  configDirectoryMessage,
  stateDirectory,
  stateDirectoryMessage,
} from "./directories.js";
export {
  ExecutionLimitError,
  IncompleteStepError,
  SessionBusyError,
  SessionFencedError,
  SessionReleasedError,
  SessionSaveError,
  StepProtocolError,
  ToolRegistrationError,
  TranscriptError,
} from "./session/errors.js";
export { isPlainData } from "./session/plain.js";
export type {
  CompleteStep,
  StepResult,
  StepToolResult,
  ToolCallRequest,
  ToolDecision,
} from "./session/step.js";
export { Turn } from "./session/turn.js";
export type { ExecutionLimits, ExecutionUsage } from "./session/turn.js";
