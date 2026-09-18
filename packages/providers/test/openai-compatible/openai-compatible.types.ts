import type { Provider } from "@mitome/core";
import { openaiCompatible } from "../../src/openai-compatible/index.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

const provider = openaiCompatible({
  id: "acme",
  baseUrl: "http://localhost:1234/v1",
  apiKeyEnv: "ACME_API_KEY",
});
const contract: Assert<Equal<typeof provider, Provider<"acme", readonly []>>> = true;
void contract;

// @ts-expect-error A compatible endpoint requires its base URL.
openaiCompatible({ id: "missing-base" });
// @ts-expect-error Provider ids cannot contain the Model separator.
openaiCompatible({ id: "bad/id", baseUrl: "http://localhost:1234" });
// Declared context windows are keyed by endpoint-native Model id and must be numbers.
openaiCompatible({
  id: "windowed",
  baseUrl: "http://localhost:1234",
  models: { "llama-3.1-8b": { contextWindow: 128_000 } },
});
openaiCompatible({
  id: "bad-window",
  baseUrl: "http://localhost:1234",
  // @ts-expect-error contextWindow is a token count, not a string.
  models: { "llama-3.1-8b": { contextWindow: "128k" } },
});
