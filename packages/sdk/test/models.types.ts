import type { Prompt } from "../src/index.js";

const invalidUserPrompt = {
  content: [
    {
      role: "user",
      content: [{ type: "tool-result", id: "id", name: "tool", isFailure: false, result: null }],
    },
  ],
} as const;
// @ts-expect-error User Messages cannot contain Tool result parts.
const prompt: Prompt = invalidUserPrompt;
void prompt;
