import { z } from "zod";
import { defineExtension } from "@mitome/sdk";

interface Notes {
  readonly values: Array<string>;
}

export const notes = defineExtension({
  name: "notes",
  instructions: "Save a note when the user asks you to remember something.",
  resource: async ({ defer }): Promise<Notes> => {
    const notes: Notes = { values: [] };
    defer(() => void notes.values.splice(0));
    return notes;
  },
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
