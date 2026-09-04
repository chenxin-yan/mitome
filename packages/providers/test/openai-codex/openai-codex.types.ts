import type { Provider } from "@mitome/core";
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
    Equal<typeof codex, (options?: CodexOptions) => Provider<"openai-codex", typeof knownModelIds>>
  >,
] = [true, true];
void publicContracts;
