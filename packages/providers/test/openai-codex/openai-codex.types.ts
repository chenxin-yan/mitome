import type { Provider } from "@mitome/core";
import type { Effect, Types } from "effect";
import type { AiError } from "effect/ai";
import type {
  codex,
  knownModelIds,
  login,
  logout,
  CodexOptions,
  KnownModelId,
} from "../../src/openai-codex/index.js";

type Assert<T extends true> = T;
const publicContracts: [
  Assert<Types.Equals<string extends KnownModelId ? true : false, false>>,
  Assert<
    // Provisioning fails with a configuration message or a native credential AiError.
    Types.Equals<
      typeof codex,
      (
        options?: CodexOptions,
      ) => Provider.Provider<"openai-codex", typeof knownModelIds, string | AiError.AiError, never>
    >
  >,
  // Signing in and out are Effects that need no service, as an Auth capability is.
  Assert<
    Types.Equals<ReturnType<typeof login> extends Effect.Effect<void, Error> ? true : false, true>
  >,
  Assert<
    Types.Equals<ReturnType<typeof logout> extends Effect.Effect<void, Error> ? true : false, true>
  >,
] = [true, true, true, true];
void publicContracts;
