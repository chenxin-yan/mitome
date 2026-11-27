import type { Config, Types } from "effect";
import type { Provider } from "@mitome/core";
import type {
  anthropic,
  knownModelIds,
  AnthropicOptions,
  KnownModelId,
  MissingCredentialError,
  UnusableProfileError,
} from "../../src/anthropic/index.js";

type Assert<T extends true> = T;

const publicContracts: [
  Assert<
    // Provisioning fails without either Credential, with a Claude Console profile it cannot use,
    // or with an unreadable configuration source, and needs nothing further.
    Types.Equals<
      typeof anthropic,
      (
        options?: AnthropicOptions,
      ) => Provider.Provider<
        "anthropic",
        typeof knownModelIds,
        MissingCredentialError | UnusableProfileError | Config.ConfigError,
        never
      >
    >
  >,
  Assert<Types.Equals<string extends KnownModelId ? true : false, false>>,
] = [true, true];
void publicContracts;
