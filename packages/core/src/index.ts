/**
 * Effect-native Session, Turn, controlled Step, Provider and loadable application surface.
 *
 * @module @mitome/core
 */

export {
  ApplicationClosedError,
  defineMitome,
  mitomeProtocol,
  ModelSelectionError,
} from "./application.js";
export type {
  AcquireOptions,
  Application,
  ApplicationSession,
  Mitome,
  MitomeCli,
  MitomeHost,
  MitomeOptions,
  ProviderDiscovery,
} from "./application.js";
export { configDirectory, configDirectoryMessage } from "./config.js";
export { CredentialDescriptorSchema } from "./credential.js";
export type { AuthCapability, AuthenticateOptions, CredentialDescriptor } from "./credential.js";
export { credentialDescriptor, makeProvider, providerModel } from "./provider.js";
export type {
  AnyProvider,
  ModelMetadata,
  ModelMetadataMap,
  Provider,
  QualifiedModelId,
  ValidProviderId,
} from "./provider.js";
export {
  ExecutionLimitError,
  IncompleteStepError,
  SessionBusyError,
  SessionFencedError,
  SessionReleasedError,
  SessionSaveError,
  StepProtocolError,
  ToolRegistrationError,
} from "./session/errors.js";
export { firstPartyExecutionLimits, makeSession, Turn } from "./session/session.js";
export type {
  ExecutionLimits,
  ExecutionUsage,
  NonDurableSession,
  Session,
  SessionOptions,
  SessionStore,
  TurnObservation,
  TurnReceipt,
  TurnSnapshot,
} from "./session/session.js";
export {
  localTools,
  loop,
  ModelRequestAccounting,
  reportModelRequest,
  step,
  toolOutcomes,
  withModelRequestAccounting,
} from "./session/step.js";
export type {
  CompleteStep,
  IncompleteStep,
  LocalTools,
  StepOptions,
  StepResult,
  ToolCallRequest,
  ToolDecision,
} from "./session/step.js";
