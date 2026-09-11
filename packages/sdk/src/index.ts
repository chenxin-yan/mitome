/**
 * Promise-first application surface: define Agents and Extensions, run Sessions, and persist
 * Transcripts without any Effect type in a public signature.
 *
 * @module @mitome/sdk
 */

export {
  AgentDefinitionError,
  ApprovalResolutionError,
  SessionBusyError,
  SessionReleasedError,
  StoreError,
  TranscriptNotFound,
  TranscriptSchemaVersion,
  TurnError,
} from "@mitome/core";
export type {
  AgentDefinition,
  AnyExtension,
  AnyProvider,
  Extension,
  Provider,
  QualifiedModelId,
  ToolExecutionDenied,
  Transcript,
  TranscriptEventRecord,
  TranscriptId,
  TranscriptMessage,
  TranscriptSummary,
  TurnEventDto,
  TurnOptions,
} from "@mitome/core";
export { defineAgent } from "./agent.js";
export { defineExtension, fail, ok } from "./extension.js";
export type {
  AnyTool,
  ExtensionDefinition,
  ExtensionHooksDefinition,
  HookContext,
  InputSchema,
  OutputSchema,
  StandardSchema,
  StepEndContext,
  Tool,
  ToolApprovalContext,
  ToolBuilder,
  ToolContributionsOf,
  ToolContribution,
  ToolFailure,
  ToolHookContext,
  ToolResultHookContext,
  ToolSuccess,
} from "./extension.js";
export { defineMitome } from "./mitome.js";
export type { MitomeDefinition } from "./mitome.js";
export type {
  FinishReason,
  Json,
  Prompt,
  PromptMessage,
  PromptPart,
  ProviderOptions,
  ResponsePart,
  Usage,
} from "./models.js";
export { withSession } from "./session.js";
export type { Session, SessionOptions, TurnEvent } from "./session.js";
export { fileTranscripts, memoryTranscripts } from "./transcript-store.js";
export type { TranscriptStore } from "./transcript-store.js";
