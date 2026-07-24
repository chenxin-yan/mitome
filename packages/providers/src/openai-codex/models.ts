// Hand-maintained hints: the undocumented backend has no safe model-discovery API.
// Source: https://developers.openai.com/codex/models (verified 2026-07-15).
export const knownModelIds = [
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;

export type KnownModelId = (typeof knownModelIds)[number];
