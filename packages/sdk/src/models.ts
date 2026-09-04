import type { Json } from "@mitome/core";

export type { Json } from "@mitome/core";

/** Provider-specific options attached to a Message or part; opaque to Mitome. */
export type ProviderOptions = Readonly<Record<string, Json>>;

interface PromptPartBase<Type extends string> {
  readonly type: Type;
  readonly options?: ProviderOptions | undefined;
}

/** One content part of a Model Prompt Message. */
export type PromptPart =
  | (PromptPartBase<"text"> & { readonly text: string })
  | (PromptPartBase<"reasoning"> & { readonly text: string })
  | (PromptPartBase<"file"> & {
      readonly mediaType: string;
      readonly fileName?: string | undefined;
      readonly data: string | Uint8Array | URL;
    })
  | (PromptPartBase<"tool-call"> & {
      readonly id: string;
      readonly name: string;
      readonly params: unknown;
      readonly providerExecuted?: boolean | undefined;
    })
  | (PromptPartBase<"tool-result"> & {
      readonly id: string;
      readonly name: string;
      readonly isFailure: boolean;
      readonly result: unknown;
      readonly providerExecuted?: boolean | undefined;
    })
  | (PromptPartBase<"tool-approval-response"> & {
      readonly approvalId: string;
      readonly approved: boolean;
      readonly reason?: string | undefined;
    })
  | (PromptPartBase<"tool-approval-request"> & {
      readonly approvalId: string;
      readonly toolCallId: string;
    });

interface PromptMessageBase<Role extends string> {
  readonly role: Role;
  readonly options?: ProviderOptions | undefined;
}

type PromptPartOf<Type extends PromptPart["type"]> = Extract<PromptPart, { readonly type: Type }>;
type UserPromptPart = PromptPartOf<"text" | "file">;
type AssistantPromptPart = PromptPartOf<
  "text" | "reasoning" | "file" | "tool-call" | "tool-result" | "tool-approval-request"
>;
type ToolPromptPart = PromptPartOf<"tool-result" | "tool-approval-response">;

/** One Message of a Model Prompt, by role; each role permits its own part types. */
export type PromptMessage =
  | (PromptMessageBase<"system"> & { readonly content: string })
  | (PromptMessageBase<"user"> & {
      readonly content: string | ReadonlyArray<UserPromptPart>;
    })
  | (PromptMessageBase<"assistant"> & {
      readonly content: string | ReadonlyArray<AssistantPromptPart>;
    })
  | (PromptMessageBase<"tool"> & { readonly content: ReadonlyArray<ToolPromptPart> });

/** The ordered Messages supplied to a Model for one Step. */
export interface Prompt {
  readonly content: ReadonlyArray<PromptMessage>;
}

/** Why the Model stopped generating in a Step. */
export type FinishReason =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "error"
  | "pause"
  | "other"
  | "unknown";

/** Token usage of a Step; every count is optional because Providers report different detail. */
export interface Usage {
  readonly inputTokens: {
    readonly uncached?: number | undefined;
    readonly total?: number | undefined;
    readonly cacheRead?: number | undefined;
    readonly cacheWrite?: number | undefined;
  };
  readonly outputTokens: {
    readonly total?: number | undefined;
    readonly text?: number | undefined;
    readonly reasoning?: number | undefined;
  };
}

interface ResponsePartBase<Type extends string> {
  readonly type: Type;
  readonly metadata?: ProviderOptions | undefined;
}

/** One streamed part of a Model response, as `stepEnd` receives them. */
export type ResponsePart =
  | (ResponsePartBase<"text" | "reasoning"> & { readonly text: string })
  | (ResponsePartBase<"text-start" | "text-end" | "reasoning-start" | "reasoning-end"> & {
      readonly id: string;
    })
  | (ResponsePartBase<"text-delta" | "reasoning-delta" | "tool-params-delta"> & {
      readonly id: string;
      readonly delta: string;
    })
  | (ResponsePartBase<"tool-params-start"> & {
      readonly id: string;
      readonly name: string;
      readonly providerExecuted?: boolean | undefined;
    })
  | (ResponsePartBase<"tool-params-end"> & { readonly id: string })
  | (ResponsePartBase<"tool-call"> & {
      readonly id: string;
      readonly name: string;
      readonly params: unknown;
      readonly providerExecuted?: boolean | undefined;
    })
  | (ResponsePartBase<"tool-result"> & {
      readonly id: string;
      readonly name: string;
      readonly result: unknown;
      readonly isFailure: boolean;
      readonly providerExecuted?: boolean | undefined;
      readonly preliminary?: boolean | undefined;
    })
  | (ResponsePartBase<"tool-approval-request"> & {
      readonly approvalId: string;
      readonly toolCallId: string;
    })
  | (ResponsePartBase<"file"> & { readonly mediaType: string; readonly data: Uint8Array })
  | (ResponsePartBase<"source"> & {
      readonly sourceType: "document";
      readonly id: string;
      readonly mediaType: string;
      readonly title: string;
      readonly fileName?: string | undefined;
    })
  | (ResponsePartBase<"source"> & {
      readonly sourceType: "url";
      readonly id: string;
      readonly url: URL;
      readonly title: string;
    })
  | (ResponsePartBase<"response-metadata"> & {
      readonly id?: string | undefined;
      readonly modelId?: string | undefined;
      readonly timestamp?: unknown;
      readonly request?: unknown;
    })
  | (ResponsePartBase<"finish"> & {
      readonly reason: FinishReason;
      readonly usage: Usage;
      readonly response?: unknown;
    })
  | (ResponsePartBase<"error"> & { readonly error: unknown });
