/**
 * Effect-native Agents, Extensions and Configurations, and the Sessions, Turns, controlled Steps,
 * Provider contract and Approver they run on.
 *
 * @module @mitome/core
 */

// Namespace modules hold only their public names; internals live in modules the root does not export.
export * as Agent from "./agent/agent.js";
export * as Command from "./agent/command.js";
export * as Extension from "./agent/extension.js";
export * as Mitome from "./agent/mitome.js";
export * as Provider from "./session/provider.js";
export * as Session from "./agent/session.js";
export {
  CommandFailedError,
  CommandNotFoundError,
  MitomeClosedError,
  ModelSelectionError,
  TextMappingError,
  TranscriptSelectionError,
} from "./agent/errors.js";
export { Transcripts } from "./agent/transcripts.js";
export type { TranscriptsService } from "./agent/transcripts.js";
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
