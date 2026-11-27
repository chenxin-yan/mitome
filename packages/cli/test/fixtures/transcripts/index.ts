// The history fixture's Agent and Model, keeping its conversations in files under the state
// directory, as a Configuration that turned history on does.
import { Agent, Mitome } from "@mitome/core";
import { jsonlTranscripts } from "@mitome/transcripts/jsonl";
import { remembering } from "../history/index.ts";

export default Mitome.make({
  agent: Agent.make({}),
  provide: jsonlTranscripts(),
  providers: [remembering],
  model: "scripted/remember",
});
