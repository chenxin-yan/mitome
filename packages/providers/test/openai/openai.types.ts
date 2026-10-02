import type { Provider } from "@mitome/core";
import {
  type KnownModelId,
  type OpenAiOptions,
  knownModelIds,
  openai,
} from "../../src/openai/index.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

const publicContracts: [
  Assert<
    // Provisioning fails with the missing-key message and needs nothing further.
    Equal<
      typeof openai,
      (options?: OpenAiOptions) => Provider<"openai", typeof knownModelIds, string, never>
    >
  >,
  Assert<Equal<string extends KnownModelId ? true : false, false>>,
] = [true, true];
void publicContracts;
