import { defineAgent, withSession } from "@mitome/sdk";
import { openai } from "@mitome/providers/openai";

const agent = defineAgent({
  providers: [openai()],
  model: "openai/gpt-5.4-mini",
});

await withSession(agent, async (session) => {
  for await (const event of session.runTurn("Say hello in one sentence.")) {
    if (event.type === "model-output") process.stdout.write(event.text);
  }
  process.stdout.write("\n");
});
