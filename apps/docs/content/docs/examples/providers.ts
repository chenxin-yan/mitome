// #region openai-baseurl
import { env, openai } from "@mitome/openai";

export const proxied = openai("gpt-5.6", env("OPENAI_API_KEY"), {
  baseUrl: "https://openai-proxy.example/v1",
});
// #endregion openai-baseurl

// #region openai-compatible
import { env as compatibleEnv, openaiCompatible } from "@mitome/openai-compatible";

export const compatible = openaiCompatible("provider-model", compatibleEnv("PROVIDER_API_KEY"), {
  baseUrl: "https://provider.example/v1",
});
// #endregion openai-compatible
