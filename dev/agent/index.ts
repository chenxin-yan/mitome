import { Mitome } from "@mitome/core";
import { anthropic } from "@mitome/providers/anthropic";
import { openai } from "@mitome/providers/openai";
import { codex } from "@mitome/providers/openai-codex";
import { jsonlTranscripts } from "@mitome/transcripts/jsonl";
import { agent } from "./agent.js";

export default Mitome.make({
  agent,
  providers: [openai(), codex(), anthropic()],
  model: "openai-codex/gpt-5.5",
  // Dogfooding keeps its conversations, so that `--continue` gets real use; they live under the
  // state directory the dev CLI sets, `.dev-home`.
  provide: jsonlTranscripts(),
});
