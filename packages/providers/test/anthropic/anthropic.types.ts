import type { Config } from "effect";
import type { Provider } from "@mitome/core";
import {
  type AnthropicOptions,
  type KnownModelId,
  type MissingCredentialError,
  anthropic,
  knownModelIds,
} from "../../src/anthropic/index.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

const publicContracts: [
  Assert<
    // Provisioning fails with the missing-key message or an unreadable configuration source and
    // needs nothing further.
    Equal<
      typeof anthropic,
      (
        options?: AnthropicOptions,
      ) => Provider.Provider<
        "anthropic",
        typeof knownModelIds,
        MissingCredentialError | Config.ConfigError,
        never
      >
    >
  >,
  Assert<Equal<string extends KnownModelId ? true : false, false>>,
] = [true, true];
void publicContracts;
