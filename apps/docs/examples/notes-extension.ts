import { z } from "zod";
import { defineExtension } from "@mitome/sdk";

interface Notes {
  readonly values: Array<string>;
}

export const notes = defineExtension({
  name: "notes",
  instructions: "Save a note when the user asks you to remember something.",
  setup: async (): Promise<Notes> => ({ values: [] }),
  dispose: async (resource) => void resource.values.splice(0),
  tools: ({ tool }) => [
    tool({
      name: "save_note",
      description: "Save one note for this Session",
      inputSchema: z.object({ text: z.string() }),
      handler: async ({ text }, { resource, signal }) => {
        signal.throwIfAborted();
        resource.values.push(text);
        return `Saved ${resource.values.length} note(s)`;
      },
    }),
  ],
});
