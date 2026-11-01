import type { Provider } from "@mitome/core";
import type { AiError } from "effect/ai";
import {
  type CodexOptions,
  type KnownModelId,
  codex,
  knownModelIds,
} from "../../src/openai-codex/index.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
const publicContracts: [
  Assert<Equal<string extends KnownModelId ? true : false, false>>,
  Assert<
    // Provisioning fails with a configuration message or a native credential AiError.
    Equal<
      typeof codex,
      (
        options?: CodexOptions,
      ) => Provider<"openai-codex", typeof knownModelIds, string | AiError.AiError, never>
    >
  >,
] = [true, true];
void publicContracts;
