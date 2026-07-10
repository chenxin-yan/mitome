import type { Model } from "@mitome/core";
import { type Credential, type ModelId, type OpenAiOptions, env, openai } from "../src/index.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type PublicOpenAi = (model: ModelId, credential: Credential, options?: OpenAiOptions) => Model;
type PublicEnv = (name: string) => Credential;

const publicContracts: [
  Assert<Equal<typeof openai, PublicOpenAi>>,
  Assert<Equal<typeof env, PublicEnv>>,
] = [true, true];
void publicContracts;
