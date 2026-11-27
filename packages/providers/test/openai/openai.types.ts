import type { Config, Types } from "effect";
import type { Provider } from "@mitome/core";
import type {
  knownModelIds,
  openai,
  KnownModelId,
  MissingCredentialError,
  OpenAiOptions,
} from "../../src/openai/index.js";

type Assert<T extends true> = T;

const publicContracts: [
  Assert<
    // Provisioning fails with the missing-key message or an unreadable configuration source and
    // needs nothing further.
    Types.Equals<
      typeof openai,
      (
        options?: OpenAiOptions,
      ) => Provider.Provider<
        "openai",
        typeof knownModelIds,
        MissingCredentialError | Config.ConfigError,
        never
      >
    >
  >,
  Assert<Types.Equals<string extends KnownModelId ? true : false, false>>,
] = [true, true];
void publicContracts;
