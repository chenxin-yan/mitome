import type { Model } from "@mitome/core";
import {
  type Credential,
  type KnownModelId,
  type ModelId,
  type OpenAiOptions,
  env,
  openai,
} from "../../src/openai/index.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

// Public shapes are pinned to literals (not the exported aliases) so a leaked
// Effect/Redacted field or a ModelId degrading to plain string fails to compile.
const publicContracts: [
  Assert<
    Equal<typeof openai, (model: ModelId, credential: Credential, options?: OpenAiOptions) => Model>
  >,
  Assert<Equal<typeof env, (name: string) => Credential>>,
  Assert<Equal<Credential, { readonly name: string }>>,
  Assert<
    Equal<OpenAiOptions, { readonly baseUrl?: string; readonly transport?: "http" | "websocket" }>
  >,
  Assert<Equal<ModelId, KnownModelId | (string & {})>>,
  // KnownModelId must stay a literal union that still provides autocomplete.
  Assert<Equal<string extends KnownModelId ? true : false, false>>,
] = [true, true, true, true, true, true];
void publicContracts;
