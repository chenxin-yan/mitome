import { defineAgent } from "@mitome/sdk";
import { codex } from "@mitome/openai-codex";

// #region definition
export default defineAgent({
  instructions: "You are a concise assistant.",
  model: codex("gpt-5.5"),
  plugins: [],
});
// #endregion definition
