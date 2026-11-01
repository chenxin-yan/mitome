import { Result, Schema } from "effect";

export const catalogUrl = "https://models.dev/api.json";

const NonEmptyString = Schema.String.check(Schema.isNonEmpty());
const ModelsDevEnvelope = Schema.Struct({
  openai: Schema.Struct({ models: Schema.Record(Schema.String, Schema.Unknown) }),
});
const ModelsDevModel = Schema.Struct({ id: NonEmptyString, tool_call: Schema.Boolean });
// Checked apart from ModelsDevModel so a missing or malformed limit never drops a Model id.
const ModelsDevContextLimit = Schema.Struct({
  limit: Schema.Struct({ context: Schema.Int.check(Schema.isGreaterThan(0)) }),
});

export interface OpenAiCatalogModel {
  readonly id: string;
  /** `limit.context` from models.dev; undefined when absent or not a positive integer. */
  readonly contextWindow: number | undefined;
}

// models.dev describes the OpenAI API only; Codex suggestions come from the
// hand-maintained list in @mitome/providers/openai-codex (ADR-0028).
export const toolCapableOpenAiModels = <Payload>(payload: Payload): Array<OpenAiCatalogModel> => {
  const envelope = Schema.decodeUnknownResult(ModelsDevEnvelope)(payload);
  if (Result.isFailure(envelope)) return [];
  return Object.values(envelope.success.openai.models).flatMap((model) => {
    const decoded = Schema.decodeUnknownResult(ModelsDevModel)(model);
    if (Result.isFailure(decoded) || !decoded.success.tool_call) return [];
    return [
      {
        id: decoded.success.id,
        contextWindow: Schema.is(ModelsDevContextLimit)(model) ? model.limit.context : undefined,
      },
    ];
  });
};
