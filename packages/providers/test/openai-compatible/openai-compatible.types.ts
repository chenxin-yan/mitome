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
