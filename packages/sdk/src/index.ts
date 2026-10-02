/**
 * Promise-first application surface: define Agents and Extensions and persist Transcripts without
 * any Effect type in a public signature. Sessions and Turns are Effect-native; see
 * `@mitome/sdk/effect`.
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
  ApprovalPolicy,
  ApprovalPolicyCall,
  ApprovalPolicyCallback,
  ApprovalPolicyDecision,
  ApprovalRequirement,
  ApprovalRules,
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
  ResourceContext,
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
export { fileTranscripts, memoryTranscripts } from "./transcript-store.js";
export type { TranscriptStore } from "./transcript-store.js";
