import { Mitome } from "@mitome/core";
import { anthropic } from "@mitome/providers/anthropic";
import { openai } from "@mitome/providers/openai";
import { codex } from "@mitome/providers/openai-codex";
import { agent } from "./agent.js";

export default Mitome.make({
  agent,
  providers: [openai(), codex(), anthropic()],
  model: "openai-codex/gpt-5.5",
});
