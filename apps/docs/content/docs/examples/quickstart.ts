import { withSession } from "@mitome/sdk";

// #region definition
import { defineAgent } from "@mitome/sdk";
import { env, openai } from "@mitome/openai";

const agent = defineAgent({
  instructions: "You are a concise assistant.",
  model: openai("gpt-5.4-mini", env("OPENAI_API_KEY")),
  plugins: [],
});

export default agent;
// #endregion definition

// #region interactive
export const runInteractive = async (
  read: () => Promise<string | undefined>,
  write: (text: string) => void,
): Promise<void> => {
  await withSession(agent, async (session) => {
    while (true) {
      const text = await read();
      if (text === undefined) return;
      for await (const event of session.prompt(text)) {
        if (event.type === "model-output") write(event.text);
        if (event.type === "response-complete") write("\n");
      }
    }
  });
};
// #endregion interactive
