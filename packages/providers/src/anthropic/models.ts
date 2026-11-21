// Hand-maintained hints: the models.dev snapshot covers OpenAI only.
// Source: the Active Models on Anthropic's model deprecations page, read 2026-11-21, newest first.
/** Anthropic Model ids offered as completions; not a closed catalog. */
export const knownModelIds = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5-2",
  "claude-mythos-5-2",
  "claude-fable-5-1",
  "claude-mythos-5-1",
  "claude-fable-5",
  "claude-mythos-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-haiku-4-5",
] as const;

/** One id from `knownModelIds`. */
export type KnownModelId = (typeof knownModelIds)[number];
