import { defineAgent, memoryTranscripts, withSession } from "@mitome/sdk";
import { openai } from "@mitome/providers/openai";

const agent = defineAgent({
  providers: [openai()],
  model: "openai/gpt-5.4-mini",
});
const transcripts = memoryTranscripts();

const parentId = await withSession(agent, { transcripts }, async (session) => {
  await Array.fromAsync(session.runTurn("Remember that my project is blue."));
  return session.transcript().id;
});

await withSession(agent, { transcripts, resume: parentId }, async (session) => {
  for await (const event of session.runTurn("What color is my project?")) {
    if (event.type === "model-output") process.stdout.write(event.text);
  }
});
